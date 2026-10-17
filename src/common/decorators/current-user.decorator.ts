/**
 * Hỗ trợ lấy toàn bộ đối tượng RequestUserContext hoặc trích xuất chính xác một trường thuộc tính con.
 * Ưu tiên request.user (JwtAuthGuard gán), fallback về RequestContextService (WebSocket, user được nạp lại).
 *
 * @example
 * findMine(@CurrentUser() user: RequestUserContext, @CurrentUser('id') userId: string)
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestUserContext } from '../../core/context/request-context.model';
import { RequestContextService } from '../../core/context/request-context.service';

export const CurrentUser = createParamDecorator(
  (data: keyof RequestUserContext | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user: RequestUserContext | undefined = request?.user ?? RequestContextService.current()?.user;

    if (!user) {
      return undefined;
    }

    return data ? user[data] : user;
  },
);
