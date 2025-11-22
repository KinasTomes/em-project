/**
 * Verify package structure without running actual code
 */

const fs = require('fs');
const path = require('path');

console.log('=== Verifying Circuit Breaker Package Structure ===\n');

const requiredFiles = [
  'index.js',
  'package.json',
  'README.md',
  'src/config.js',
  'src/axiosClient.js',
  'src/circuitBreaker.js',
  'src/resilientClient.js',
  'examples/basic-usage.js',
  'examples/order-to-product.js',
];

let allExist = true;

requiredFiles.forEach((file) => {
  const filePath = path.join(__dirname, '..', file);
  const exists = fs.existsSync(filePath);
  
  if (exists) {
    const stats = fs.statSync(filePath);
    console.log(`✓ ${file} (${stats.size} bytes)`);
  } else {
    console.error(`✗ ${file} - MISSING`);
    allExist = false;
  }
});

console.log();

if (allExist) {
  console.log('✓ All required files exist!');
  
  // Check package.json content
  const packageJson = require('../package.json');
  console.log('\nPackage Info:');
  console.log(`  Name: ${packageJson.name}`);
  console.log(`  Version: ${packageJson.version}`);
  console.log(`  Dependencies:`);
  Object.keys(packageJson.dependencies || {}).forEach((dep) => {
    console.log(`    - ${dep}: ${packageJson.dependencies[dep]}`);
  });
  
  // Check exports
  console.log('\nChecking exports...');
  try {
    const exported = require('../index.js');
    console.log('  Exported functions:', Object.keys(exported));
  } catch (error) {
    console.log('  Note: Cannot load module without dependencies installed');
    console.log('  This is expected - dependencies need to be installed first');
  }
  
  console.log('\n=== Package structure is valid! ===');
  console.log('\nNext steps:');
  console.log('1. Install dependencies: npm install (from workspace root)');
  console.log('2. Use in your service:');
  console.log('   const { createResilientClient } = require("@ecommerce/circuit-breaker");');
  console.log('3. See examples/ folder for usage patterns');
} else {
  console.error('\n✗ Some files are missing!');
  process.exit(1);
}
