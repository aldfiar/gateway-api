const appRoot = require('app-root-path')
const winston = require('winston');

const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.align(),
  winston.format.printf(
    info => {
      const local = new Date()
      const timestamp = local.toLocaleString()
      return `${timestamp} | ${info.level} | ${info.message}`
    }
  ),
)

const config = {
  file: {
    level: 'info',
    filename: `${appRoot}/logs/app.log`,
    handleExceptions: false,
    // maxsize: 5242880, // 5MB
    // maxFiles: 30,
  },
  error: {
    level: 'error',
    filename: `${appRoot}/logs/error.log`,
    handleExceptions: true,
  },
  rejection: {
    level: 'error',
    filename: `${appRoot}/logs/rejection.log`,
  },
  debug: {
    level: 'debug',
    filename: `${appRoot}/logs/debug.log`,
    handleExceptions: true,
  },
}

const allLogsFileTransport = new winston.transports.File(config.file)
const errorLogsFileTransport = new winston.transports.File(config.error)
const debugTransport = new winston.transports.Console(config.debug)
const rejectionTransport = new winston.transports.File(config.rejection)

const options = {
  format: logFormat,
  transports: [allLogsFileTransport, errorLogsFileTransport, debugTransport],
  rejectionHandlers: [rejectionTransport],
  exitOnError: false,
}

export const logger = winston.createLogger(options)