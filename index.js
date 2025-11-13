const semver = require('semver');
const MIN_VERSION_FOR_NEW_IMPL = '1.16.0'; // Adjust as needed

module.exports = {
  default: semver.gte(process.env.VORTEX_VERSION || '0.0.0', MIN_VERSION_FOR_NEW_IMPL) ? require('./indexNew').default : require('./indexOld').default,
};