-- A second, throwaway database for the API's integration tests.
CREATE DATABASE IF NOT EXISTS quoting_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON quoting_test.* TO 'quoting_engine'@'%';
