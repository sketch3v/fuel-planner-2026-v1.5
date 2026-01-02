/**
 * Build script for Fuel Planner iOS App
 * Copies all web files to the www folder for Capacitor
 */

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = __dirname;
const WWW_DIR = path.join(__dirname, 'www');
const ASSETS_DIR = path.join(WWW_DIR, 'assets');

// Files to copy to www/
const FILES_TO_COPY = [
    'index.html',
    'login.html',
    'admin.html',
    'app.js',
    'auth.js',
    'admin.js',
    'fuel-prices.js',
    'styles.css',
    'auth-styles.css'
];

// Create directories
function createDirectories() {
    if (!fs.existsSync(WWW_DIR)) {
        fs.mkdirSync(WWW_DIR, { recursive: true });
        console.log('✅ Created www/ folder');
    }
    if (!fs.existsSync(ASSETS_DIR)) {
        fs.mkdirSync(ASSETS_DIR, { recursive: true });
        console.log('✅ Created www/assets/ folder');
    }
}

// Copy a single file
function copyFile(filename) {
    const src = path.join(SOURCE_DIR, filename);
    const dest = path.join(WWW_DIR, filename);
    
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`✅ Copied ${filename}`);
    } else {
        console.log(`⚠️  File not found: ${filename}`);
    }
}

// Copy assets folder
function copyAssets() {
    const assetsSource = path.join(SOURCE_DIR, 'assets');
    
    if (fs.existsSync(assetsSource)) {
        const files = fs.readdirSync(assetsSource);
        files.forEach(file => {
            const src = path.join(assetsSource, file);
            const dest = path.join(ASSETS_DIR, file);
            
            if (fs.statSync(src).isFile()) {
                fs.copyFileSync(src, dest);
                console.log(`✅ Copied assets/${file}`);
            }
        });
    } else {
        console.log('⚠️  Assets folder not found');
    }
}

// Main build process
console.log('\n🔨 Building Fuel Planner for iOS...\n');

createDirectories();

FILES_TO_COPY.forEach(copyFile);

copyAssets();

console.log('\n✅ Build complete! Run "npx cap sync ios" to update the iOS app.\n');

