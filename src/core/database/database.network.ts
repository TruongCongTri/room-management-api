/**
 * Điều khiển họ địa chỉ IP cho kết nối PostgreSQL và chẩn đoán mạng lúc khởi động.
 *
 * node-postgres không có option `family`, nhưng cho phép truyền `stream` là một factory:
 * ta tạo net.Socket và ép `family` khi driver gọi socket.connect(port, host).
 * TLS (Supabase) vẫn hoạt động bình thường vì pg bọc chính socket này bằng tls.connect({ socket, servername }).
 */
import type { LookupAddress } from 'dns';
import { lookup } from 'dns/promises';
import { isIP, Socket } from 'net';
import type {
  DatabaseConnectionConfig,
  DatabaseNodeConfig,
} from '../config/resolvers/database.resolver';
import { detectDbProvider } from '../config/resolvers/database.resolver';

type SocketConnect = (...args: unknown[]) => Socket;

export function createFamilyPinnedStream(family: 4 | 6): () => Socket {
  return () => {
    const socket = new Socket();
    const originalConnect = socket.connect.bind(socket) as SocketConnect;

    (socket as unknown as { connect: SocketConnect }).connect = (...args: unknown[]) => {
      const [portOrPath, host] = args;
      // Unix domain socket (host bắt đầu bằng '/'): pg gọi connect(path)
      if (typeof portOrPath === 'string' && host === undefined) {
        return originalConnect(portOrPath);
      }
      return originalConnect({
        port: Number(portOrPath),
        host: host as string,
        family,
        autoSelectFamily: false,
      });
    };

    return socket;
  };
}

export interface DnsDiagnostic {
  role: 'master' | 'replica';
  host: string;
  ipv4: string[];
  ipv6: string[];
}

interface DiagnosticLogger {
  log(message: string): void;
  warn(message: string): void;
}

function familyHint(node: DatabaseNodeConfig, family: 4 | 6): string {
  const provider = detectDbProvider(node.host);
  if (provider === 'supabase-direct' && family === 4) {
    return (
      'Supabase direct connections are IPv6-only. On IPv4-only networks use the Supavisor session pooler: ' +
      'postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres ' +
      '(or enable the Supabase IPv4 add-on).'
    );
  }
  if (provider === 'supabase-pooler' && family === 6) {
    return (
      'The Supabase shared pooler is IPv4-only. Set DB_IP_FAMILY=4 (or 0), or connect over IPv6 to the ' +
      'direct host db.<project-ref>.supabase.co:5432 with user "postgres".'
    );
  }
  return `Set DB_IP_FAMILY=0 (auto) or ${family === 4 ? 6 : 4}, or point the host at an address of the right family.`;
}

/**
 * Phân giải DNS các node trước khi mở pool:
 *  - Ném lỗi có hướng dẫn khi DB_IP_FAMILY ép một họ địa chỉ mà host không có bản ghi tương ứng
 *    (thay vì để driver báo ENOTFOUND / ENETUNREACH khó hiểu sau nhiều lần retry).
 *  - Cảnh báo khi host Supabase chỉ có IPv6 mà ứng dụng để chế độ tự động.
 */
export async function diagnoseDatabaseNetwork(
  db: DatabaseConnectionConfig,
  logger: DiagnosticLogger,
): Promise<DnsDiagnostic[]> {
  const nodes: Array<['master' | 'replica', DatabaseNodeConfig | undefined]> = [
    ['master', db.master],
    ['replica', db.replica],
  ];
  const diagnostics: DnsDiagnostic[] = [];

  for (const [role, node] of nodes) {
    if (!node || isIP(node.host) !== 0 || node.host.startsWith('/')) continue;

    let addresses: LookupAddress[];
    try {
      addresses = await lookup(node.host, { all: true, verbatim: true });
    } catch (err: any) {
      // Lỗi DNS tạm thời trong cluster: để TypeORM tự retry, chỉ ghi cảnh báo rõ ràng
      logger.warn(`[Database] DNS lookup for ${role} host '${node.host}' failed: ${err.code ?? err.message}`);
      continue;
    }

    const diagnostic: DnsDiagnostic = {
      role,
      host: node.host,
      ipv4: addresses.filter((a) => a.family === 4).map((a) => a.address),
      ipv6: addresses.filter((a) => a.family === 6).map((a) => a.address),
    };
    diagnostics.push(diagnostic);

    logger.log(
      `[Database] ${role} '${node.host}' resolves to IPv4=[${diagnostic.ipv4.join(', ')}] IPv6=[${diagnostic.ipv6.join(', ')}]`,
    );

    if (db.ipFamily === 4 && diagnostic.ipv4.length === 0) {
      throw new Error(
        `[Database] DB_IP_FAMILY=4 but ${role} host '${node.host}' has no IPv4 (A) record. ${familyHint(node, 4)}`,
      );
    }
    if (db.ipFamily === 6 && diagnostic.ipv6.length === 0) {
      throw new Error(
        `[Database] DB_IP_FAMILY=6 but ${role} host '${node.host}' has no IPv6 (AAAA) record. ${familyHint(node, 6)}`,
      );
    }
    if (db.ipFamily === 0 && diagnostic.ipv4.length === 0 && detectDbProvider(node.host) === 'supabase-direct') {
      logger.warn(`[Database] '${node.host}' is reachable over IPv6 only. ${familyHint(node, 4)}`);
    }
  }

  return diagnostics;
}
