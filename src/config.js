/**
 * Application configuration, resolved from the environment with safe defaults.
 * No secrets live in source — copy .env.example to .env to override.
 */
require('dotenv').config();

const config = {
    port: parseInt(process.env.PORT, 10) || 3001,
    env: process.env.NODE_ENV || 'development',
    maxUploadBytes: (parseInt(process.env.MAX_UPLOAD_MB, 10) || 10) * 1024 * 1024
};

module.exports = config;
