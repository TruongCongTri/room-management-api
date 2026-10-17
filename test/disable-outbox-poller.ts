/**
 * Import TRƯỚC AppModule: ConfigModule.forRoot() xác thực env ngay khi AppModule được import,
 * nên đặt biến trong beforeAll là quá muộn. Jest cấp cho mỗi file test một bản sao process.env
 * nên thiết lập này không ảnh hưởng file e2e khác.
 */
process.env.OUTBOX_ENABLED = 'false';
