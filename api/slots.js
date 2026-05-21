/**
 * api/slots.js
 * Alias to salonboard.js for fetching available slots
 * GET /api/slots[?service=hair|white|lash|spa]  → available slots
 */

module.exports = require('./salonboard');
