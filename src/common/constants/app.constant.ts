/**
 * Các hằng số cấu hình mặc định cho dữ liệu phân trang, lọc và môi trường:
 * 
 * */ 

export const APP_CONSTANTS = {
  PAGINATION: {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
  },
  SORT_ORDER: {
    ASC: 'ASC',
    DESC: 'DESC',
  } as const,
  DEFAULT_LANGUAGE: 'vi',
  SUPPORTED_LANGUAGES: ['vi', 'en', 'ja', 'ko'],
} as const;