/**
 * Danh mục sự kiện miền của nền tảng cho thuê phòng (`<aggregate>.<past_tense>`).
 * Dùng chung cho Outbox (event_type), EventEmitter in-process và BullMQ domain-events-queue.
 */
export const DOMAIN_EVENTS = {
  ROOM: {
    STATUS_CHANGED: 'room.status_changed',
    CHECKED_OUT: 'room.checked_out',
  },
  TENANT: {
    REGISTERED: 'tenant.registered',
    PII_ANONYMIZED: 'tenant.pii_anonymized',
  },
  CONTRACT: {
    ACTIVATED: 'contract.activated',
    RENEWED: 'contract.renewed',
    TERMINATED: 'contract.terminated',
    /** Người đứng tên chuyển đi, quyền đứng tên (và CCCD của hợp đồng) chuyển cho người kế nhiệm */
    PRIMARY_HOLDER_CHANGED: 'contract.primary_holder_changed',
  },
  OCCUPANT: {
    MOVED_IN: 'occupant.moved_in',
    MOVED_OUT: 'occupant.moved_out',
  },
  RESIDENCE: {
    /** Người mới chuyển đến cần lập CT01 / khai báo tạm trú người nước ngoài */
    DECLARATION_REQUIRED: 'residence.declaration_required',
    /** Người chuyển đi cần xóa đăng ký tạm trú */
    DEREGISTRATION_REQUIRED: 'residence.deregistration_required',
    STATUS_CHANGED: 'residence.status_changed',
  },
  DEPOSIT: {
    COLLECTED: 'deposit.collected',
    DEDUCTED: 'deposit.deducted',
    REFUNDED: 'deposit.refunded',
  },
  METER_READING: {
    RECORDED: 'meter_reading.recorded',
    ANOMALY_DETECTED: 'meter_reading.anomaly_detected',
    RESET_APPROVED: 'meter_reading.reset_approved',
  },
  INVOICE: {
    GENERATED: 'invoice.generated',
    OVERDUE: 'invoice.overdue',
    PAID: 'invoice.paid',
  },
  PAYMENT: {
    RECEIVED: 'payment.received',
    FAILED: 'payment.failed',
  },
  CHECKOUT: {
    SETTLED: 'checkout.settled',
  },
  COMPLIANCE: {
    PCCC_EXPIRING: 'compliance.pccc_expiring',
    RESIDENCE_RENEWAL_DUE: 'compliance.residence_renewal_due',
    TAX_EXPORTED: 'compliance.tax_exported',
  },
} as const;
