'use strict';

// Always use production build — development build also lacks useEffectEvent,
// and we only have the production file from claude-code's internal React build.
module.exports = require('./cjs/react-reconciler.production.js');
