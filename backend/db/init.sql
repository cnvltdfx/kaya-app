-- Runs once when the local MySQL container is first created (see docker-compose.yml).
CREATE DATABASE IF NOT EXISTS kaya_test;
GRANT ALL PRIVILEGES ON kaya_test.* TO 'kaya'@'%';
