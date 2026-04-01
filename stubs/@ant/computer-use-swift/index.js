const path = require('path');

// Load the extracted native module
const nativePath = path.resolve(__dirname, '..', '..', '..', 'vendor', 'native', 'computer-use-swift.node');
const native = require(nativePath);

// The package exports the computerUse object with sub-APIs
module.exports = native.computerUse;
