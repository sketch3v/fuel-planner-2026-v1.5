/**
 * ============================================
 * FUEL PRICES MODULE
 * Manages fuel price data for Pilot/Flying J stations
 * ============================================
 * 
 * This module provides infrastructure to integrate real fuel prices.
 * 
 * OPTIONS FOR GETTING REAL PRICES:
 * 
 * 1. PILOT FLYING J FLEET API (Best)
 *    - Contact: https://pilotflyingj.com/fleet-solutions/
 *    - Get official API access for business partners
 * 
 * 2. GASBUDDY BUSINESS API
 *    - Website: https://business.gasbuddy.com/
 *    - Real-time prices for all stations
 * 
 * 3. MANUAL PRICE UPDATES
 *    - Update prices in Admin Dashboard
 *    - Use price exceptions feature
 */

// ============================================
// PRICE CACHE
// ============================================
const PRICES_CACHE_KEY = 'fuelPlannerPrices';
const PRICES_CACHE_TTL = 1000 * 60 * 60; // 1 hour

// ============================================
// DEFAULT REGIONAL PRICES
// Average diesel prices by region (update regularly)
// Source: EIA - https://www.eia.gov/petroleum/gasdiesel/
// ============================================
const REGIONAL_DIESEL_PRICES = {
    // West Coast (highest)
    'CA': 4.85, 'WA': 4.45, 'OR': 4.35, 'NV': 4.25, 'AZ': 3.95,
    // Mountain
    'UT': 3.75, 'CO': 3.65, 'NM': 3.55, 'WY': 3.60, 'MT': 3.70, 'ID': 3.80,
    // Midwest
    'MN': 3.45, 'WI': 3.40, 'MI': 3.50, 'IL': 3.55, 'IN': 3.45, 'OH': 3.50,
    'IA': 3.35, 'MO': 3.30, 'KS': 3.25, 'NE': 3.30, 'SD': 3.35, 'ND': 3.40,
    // South
    'TX': 3.15, 'OK': 3.10, 'AR': 3.20, 'LA': 3.15, 'MS': 3.20, 'AL': 3.25,
    'TN': 3.20, 'KY': 3.25, 'GA': 3.30, 'FL': 3.50, 'SC': 3.25, 'NC': 3.30,
    // Northeast
    'NY': 3.85, 'PA': 3.75, 'NJ': 3.70, 'CT': 3.90, 'MA': 3.85, 'NH': 3.65,
    'VT': 3.70, 'ME': 3.75, 'RI': 3.80, 'MD': 3.60, 'DE': 3.55, 'VA': 3.35,
    'WV': 3.40,
    // Default
    'DEFAULT': 3.50
};

// ============================================
// GET PRICE FOR STATION
// ============================================
function getStationPrice(station) {
    // 1. First check admin price exceptions (highest priority)
    const exception = getAdminPriceException(station.stationNumber || station.number);
    if (exception) {
        return exception.discountedPrice;
    }
    
    // 2. Check cached real prices
    const cachedPrice = getCachedPrice(station.stationNumber || station.number);
    if (cachedPrice) {
        return cachedPrice;
    }
    
    // 3. Fall back to regional estimate
    return getRegionalPrice(station.state);
}

// ============================================
// GET ADMIN PRICE EXCEPTION
// ============================================
function getAdminPriceException(storeNumber) {
    try {
        const saved = localStorage.getItem('fuelPlannerPriceExceptions');
        const exceptions = saved ? JSON.parse(saved) : [];
        return exceptions.find(e => e.storeNumber === String(storeNumber));
    } catch (e) {
        return null;
    }
}

// ============================================
// GET CACHED PRICE
// ============================================
function getCachedPrice(storeNumber) {
    try {
        const cached = localStorage.getItem(PRICES_CACHE_KEY);
        if (!cached) return null;
        
        const data = JSON.parse(cached);
        const now = Date.now();
        
        // Check if cache is still valid
        if (data.timestamp && (now - data.timestamp) > PRICES_CACHE_TTL) {
            return null; // Cache expired
        }
        
        return data.prices?.[storeNumber] || null;
    } catch (e) {
        return null;
    }
}

// ============================================
// GET REGIONAL PRICE ESTIMATE
// ============================================
function getRegionalPrice(state) {
    return REGIONAL_DIESEL_PRICES[state] || REGIONAL_DIESEL_PRICES['DEFAULT'];
}

// ============================================
// SAVE PRICES TO CACHE
// ============================================
function cachePrices(prices) {
    try {
        const data = {
            timestamp: Date.now(),
            prices: prices
        };
        localStorage.setItem(PRICES_CACHE_KEY, JSON.stringify(data));
    } catch (e) {
        console.error('Failed to cache prices:', e);
    }
}

// ============================================
// FETCH PRICES FROM API (placeholder)
// ============================================
async function fetchPricesFromAPI() {
    // TODO: Replace with actual API call when you have access
    // 
    // Example with Pilot Flying J API (when you get access):
    // const response = await fetch('https://api.pilotflyingj.com/prices', {
    //     headers: { 'Authorization': 'Bearer YOUR_API_KEY' }
    // });
    // return await response.json();
    
    // Example with GasBuddy API:
    // const response = await fetch('https://api.gasbuddy.com/v1/stations/prices', {
    //     headers: { 'X-API-Key': 'YOUR_GASBUDDY_KEY' }
    // });
    // return await response.json();
    
    console.log('⚠️ Real price API not configured. Using regional estimates.');
    return null;
}

// ============================================
// UPDATE ALL STATION PRICES
// ============================================
async function updateStationPrices(stations) {
    // Try to fetch real prices
    const realPrices = await fetchPricesFromAPI();
    
    if (realPrices) {
        cachePrices(realPrices);
    }
    
    // Apply prices to stations
    return stations.map(station => ({
        ...station,
        price: getStationPrice(station),
        priceSource: realPrices ? 'api' : 'estimated'
    }));
}

// ============================================
// MANUAL PRICE UPDATE (for admin use)
// ============================================
function setManualPrice(storeNumber, price, source = 'manual') {
    try {
        const cached = localStorage.getItem(PRICES_CACHE_KEY);
        const data = cached ? JSON.parse(cached) : { timestamp: Date.now(), prices: {} };
        
        data.prices[storeNumber] = {
            price: price,
            source: source,
            updatedAt: new Date().toISOString()
        };
        
        localStorage.setItem(PRICES_CACHE_KEY, JSON.stringify(data));
        return true;
    } catch (e) {
        console.error('Failed to set manual price:', e);
        return false;
    }
}

// ============================================
// EXPORT FOR USE IN APP
// ============================================
window.FuelPrices = {
    getStationPrice,
    getRegionalPrice,
    updateStationPrices,
    setManualPrice,
    cachePrices,
    REGIONAL_DIESEL_PRICES
};

console.log('💰 Fuel Prices module loaded');
console.log('📝 To use real prices, configure API access in fetchPricesFromAPI()');




