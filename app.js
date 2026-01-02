/**
 * FUEL PLANNER APP
 * Main application logic for planning fuel stops along a route
 * Uses only Pilot and Flying J stations from CSV data
 * 
 * IMPORTANT: All station data comes ONLY from assets/all_locations.csv
 */

console.log('🚛 Fuel Planner v8.1 - Fixed coordinate validation');
console.log('📍 All station data from official CSV - no fake stations');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // Default map center (continental US)
    defaultCenter: [39.5, -98.35],
    defaultZoom: 2.5,
    
    // Fuel price thresholds (per gallon) - used for prioritizing cheap stations
    priceThresholds: {
        excellent: 2.95,  // Below this is excellent
        good: 3.30,       // Below this is good
        fair: 3.60        // Below this is fair, above is high
    },
    
    // Average national fuel price for savings calculation
    avgNationalPrice: 3.75,
    
    // States where you must fill to FULL before entering
    fullTankStates: ['CA', 'WA'],
    
    // Target fuel level at destination (3/4 tank = 75%)
    destinationFuelTarget: 0.75,
    
    // Minimum gallons that must remain when arriving at any station
    minArrivalGallons: 30,
    
    // Wheel picker configurations - Tank minimum is 30 gallons
    wheelConfig: {
        tank: { min: 30, max: 300, step: 10, unit: 'gal' },
        gallons: { min: 0, max: 300, step: 1, unit: 'gal' },
        mpg: { min: 5, max: 20, step: 0.1, unit: '' }
    }
};

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERY = `
[out:json][timeout:120];
area["ISO3166-1"="US"]->.usa;
(
  node["amenity"="fuel"]["brand"~"Pilot|Flying J"](area.usa);
  way["amenity"="fuel"]["brand"~"Pilot|Flying J"](area.usa);
  relation["amenity"="fuel"]["brand"~"Pilot|Flying J"](area.usa);
);
out center tags;
`;
const STATIONS_CACHE_KEY = 'pfj-stations-csv-v8';
const STATIONS_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
const DEFAULT_LOADING_TEXT = 'Calculating optimal fuel stops...';
const MAPBOX_TOKEN = 'pk.eyJ1IjoiZnVlbC1wbGFubmVyMTIiLCJhIjoiY21qMHQ5dnJ1MGN4NDNmb3I0MnJyZGI0MCJ9.KkdXjzZypxmjwzzDsGVNvA';
const MAP_ICON_CONFIG = {
    pilot: { url: 'https://locations.pilotflyingj.com/permanent-b0b701/assets/images/Pilot-pin.ce5eff40.png', width: 40, height: 52 },
    flyingj: { url: 'https://locations.pilotflyingj.com/permanent-b0b701/assets/images/FlyingJ-pin.50f2c455.png', width: 40, height: 52 }
};

function buildFallbackAddress(station = {}) {
    const street = [station.streetNumber, station.street].filter(Boolean).join(' ').trim();
    const cityState = [station.city, station.state].filter(Boolean).join(', ').trim();
    const parts = [];
    if (street) parts.push(street);
    if (cityState) parts.push(cityState);
    if (station.postalCode) parts[parts.length - 1] = `${parts[parts.length - 1]} ${station.postalCode}`;
    return parts.filter(Boolean).join(', ');
}

function removeCountryFromAddress(address) {
    if (!address) return address;
    // Remove common country suffixes (USA, United States, etc.)
    return address
        .replace(/,?\s*USA\s*$/i, '')
        .replace(/,?\s*United States\s*$/i, '')
        .replace(/,?\s*United States of America\s*$/i, '')
        .trim();
}

// ============================================
// STATE
// ============================================

let state = {
    inputMap: null,
    resultsMap: null,
    resultsMapReady: false,
    resultsRoutePolyline: null,
    resultsMarkers: [],
    stationMarkerMap: {},
    stationInfoWindow: null,
    resultsInfoWindow: null,
    userLocationMarker: null,
    userLocationWatcherId: null,
    userLocation: null,
    // IMPORTANT: Stations are loaded ONLY from CSV file - no fake data!
    stations: [],
    stationsLoaded: false,
    csvFetchInProgress: false,
    inputMapListenersAttached: false,
    addressCache: {},
    tripSummary: null,
    startCoords: null,
    endCoords: null,
    startZip: '',
    endZip: '',
    fuelStops: [],
    routeData: null,
    pendingRoute: null,
    currentWheelType: null,
    currentZipType: null
};

function clearLegacyStationCaches() {
    // Clear ALL old station caches to force fresh data load from CSV
    const oldKeys = [
        'pfj-stations-cache-v1', 'pfj-stations-csv-v1', 'pfj-stations-csv-v2', 
        'pfj-stations-csv-v3', 'pfj-stations-csv-v4', 'pfj-stations-csv-v5', 
        'pfj-stations-csv-v6', 'pfj-stations-csv-v7'
    ];
    oldKeys.forEach(key => {
        try { localStorage.removeItem(key); } catch (_) {}
    });
    console.log('🗑️ Cleared all legacy station caches - now using v8');
}

function createElementFromHTML(html) {
    const template = document.createElement('div');
    template.innerHTML = html.trim();
    return template.firstElementChild || template;
}

function createAdvancedMarker({ map, position, html, title, zIndex, anchor = 'center' }) {
    const el = html ? createElementFromHTML(html) : document.createElement('div');
    const marker = new mapboxgl.Marker({ element: el, anchor: anchor })
        .setLngLat([position.lng, position.lat]);
    marker.addTo(map);
    if (title) {
        el.title = title;
    }
    if (typeof zIndex === 'number') {
        el.style.zIndex = zIndex.toString();
    }
    return marker;
}

function updateMarkerPosition(marker, position) {
    if (!marker) return;
    if (typeof marker.setLngLat === 'function') {
        marker.setLngLat([position.lng, position.lat]);
    }
}

function removeMarker(marker) {
    if (marker && typeof marker.remove === 'function') {
        marker.remove();
    }
}

// ============================================
// INITIALIZATION / BOOTSTRAP
// ============================================

let domReady = false;
let appBootstrapped = false;

function bootstrapFuelPlanner() {
    if (appBootstrapped || !domReady) return;
    
    // Check authentication first
    if (!checkAuthentication()) {
        return; // Will redirect to login
    }
    
    if (!MAPBOX_TOKEN || MAPBOX_TOKEN.includes('YOUR_MAPBOX')) {
        console.warn('Set MAPBOX_TOKEN in app.js');
        showError('Please set MAPBOX access token in app.js');
        return;
    }
    mapboxgl.accessToken = MAPBOX_TOKEN;
    clearLegacyStationCaches();
    appBootstrapped = true;
    
    // Setup user header
    setupUserHeader();
    
    initializeInputMap();
    setupEventListeners();
    displayStationsOnMap();
    loadStationsFromCSV();
    trackUserLocation();
}

// ============================================
// AUTHENTICATION CHECK
// ============================================

function checkAuthentication() {
    // DISABLED: Login requirement removed for iOS testing
    console.log('✅ Authentication bypassed - login disabled');
    return true;
}

// ============================================
// USER HEADER SETUP
// ============================================

function setupUserHeader() {
    // Hide user header when login is disabled
    const userHeader = document.getElementById('user-header');
    if (userHeader) {
        userHeader.style.display = 'none';
    }
    return;
    
    // DISABLED: Original user header code
    const savedUser = localStorage.getItem('fuelPlannerUser');
    if (!savedUser) return;
    
    const user = JSON.parse(savedUser);
    
    // Update user avatar
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl) {
        avatarEl.textContent = user.name ? user.name.charAt(0).toUpperCase() : 'U';
    }
    
    // Update company name
    const companyEl = document.getElementById('user-company');
    if (companyEl) {
        companyEl.textContent = user.company || 'Fuel Planner';
    }
    
    // Update role badge
    const roleEl = document.getElementById('user-role');
    if (roleEl) {
        roleEl.textContent = user.role === 'admin' ? 'Administrator' : 'Driver';
    }
    
    // Show admin link for admins
    const adminLink = document.getElementById('admin-link');
    if (adminLink && user.role === 'admin') {
        adminLink.classList.remove('hidden');
        adminLink.addEventListener('click', () => {
            window.location.href = 'admin.html';
        });
    }
    
    // Setup logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
}

function handleLogout() {
    if (confirm('Are you sure you want to log out?')) {
        localStorage.removeItem('fuelPlannerUser');
        window.location.href = 'login.html';
    }
}

// ============================================
// PRICE EXCEPTIONS (from Admin Dashboard)
// ============================================

function getPriceExceptions() {
    try {
        const saved = localStorage.getItem('fuelPlannerPriceExceptions');
        return saved ? JSON.parse(saved) : [];
    } catch (e) {
        return [];
    }
}

function getExceptionForStation(storeNumber) {
    const exceptions = getPriceExceptions();
    return exceptions.find(e => e.storeNumber === storeNumber);
}

function markDomReady() {
    domReady = true;
    bootstrapFuelPlanner();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markDomReady);
} else {
    markDomReady();
}

function initializeInputMap() {
    if (!window.mapboxgl) return;
    
    state.inputMap = new mapboxgl.Map({
        container: 'input-map',
        style: 'mapbox://styles/mapbox/streets-v12',
        center: { lat: CONFIG.defaultCenter[0], lng: CONFIG.defaultCenter[1] },
        zoom: CONFIG.defaultZoom,
        attributionControl: true
    });
    
    document.getElementById('zoom-in').addEventListener('click', () => {
        if (!state.inputMap) return;
        state.inputMap.zoomTo(state.inputMap.getZoom() + 1);
    });
    
    document.getElementById('zoom-out').addEventListener('click', () => {
        if (!state.inputMap) return;
        state.inputMap.zoomTo(state.inputMap.getZoom() - 1);
    });
    
    document.getElementById('locate-me').addEventListener('click', () => {
        centerOnUserLocation(state.inputMap, 10);
    });
    
    state.inputMap.on('moveend', displayStationsOnMap);
    
    // Click on map to deselect station
    state.inputMap.on('click', (e) => {
        // Only deselect if not clicking on a marker
        const target = e.originalEvent?.target;
        if (target && !target.closest('.station-marker')) {
            deselectCurrentStation();
        }
    });
}

// Track user's location and show blue marker
function trackUserLocation() {
    if (!navigator.geolocation) {
        console.log('Geolocation not supported');
        return;
    }
    
    const handlePosition = (position) => {
        updateUserLocationMarker(position.coords.latitude, position.coords.longitude);
    };
    
    navigator.geolocation.getCurrentPosition(
        (position) => {
            handlePosition(position);
            if (state.inputMap) {
                state.inputMap.panTo({ lat: position.coords.latitude, lng: position.coords.longitude });
            }
        },
        (error) => {
            console.log('Could not get initial location:', error.message);
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
    
    if (state.userLocationWatcherId) {
        navigator.geolocation.clearWatch(state.userLocationWatcherId);
    }
    
    state.userLocationWatcherId = navigator.geolocation.watchPosition(
        handlePosition,
        (error) => {
            console.log('Location watch error:', error.message);
        },
        { enableHighAccuracy: true, maximumAge: 30000 }
    );
}

function updateUserLocationMarker(lat, lng) {
    state.userLocation = { lat, lng };
    if (!state.inputMap || !window.mapboxgl) return;
    
    if (state.userLocationMarker) {
        updateMarkerPosition(state.userLocationMarker, state.userLocation);
    } else {
        const html = `
            <div class="user-location-icon">
                <div class="user-location-marker">🚚</div>
            </div>
        `;
        state.userLocationMarker = createAdvancedMarker({
            map: state.inputMap,
            position: state.userLocation,
            html,
            zIndex: 9999
        });
    }
}

function centerOnUserLocation(map, targetZoom = null) {
    if (!map) return;
    if (state.userLocation) {
        map.flyTo({ center: [state.userLocation.lng, state.userLocation.lat], essential: true, zoom: targetZoom ?? map.getZoom() });
    } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                updateUserLocationMarker(position.coords.latitude, position.coords.longitude);
                map.flyTo({ center: [position.coords.longitude, position.coords.latitude], essential: true, zoom: targetZoom ?? map.getZoom() });
            },
            () => {
                showError('Unable to get your location. Please enable location services.');
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }
}

function displayStationsOnMap() {
    if (!state.inputMap || !state.stationsLoaded || !state.stations) return;
    if (!state.stationMarkerMap) state.stationMarkerMap = {};
    
    const bounds = state.inputMap.getBounds();
    if (!bounds) return;
    
    const currentIds = new Set();
    
    state.stations.forEach((station) => {
        // Skip stations with invalid coordinates
        if (!station.lat || !station.lng || 
            !Number.isFinite(station.lat) || !Number.isFinite(station.lng)) {
            return;
        }
        
        if (!bounds.contains([station.lng, station.lat])) {
            return;
        }
        
        currentIds.add(station.id);
        if (state.stationMarkerMap[station.id]) return;
        
        const iconConfig = MAP_ICON_CONFIG[station.type] || MAP_ICON_CONFIG.pilot;
        const html = `
            <div class="station-marker ${station.type}" data-station-id="${station.id}">
                <img src="${iconConfig.url}" alt="${station.name}" style="width:${iconConfig.width}px;height:${iconConfig.height}px;object-fit:contain;">
            </div>
        `;
        
        const marker = createAdvancedMarker({
            map: state.inputMap,
            position: { lat: station.lat, lng: station.lng },
            html,
            title: `${station.name}${station.stationNumber ? ' #' + station.stationNumber : ''}`,
            anchor: 'bottom'
        });
        
        // Store station data on marker for easy access
        marker._stationData = station;
        
        marker.getElement().addEventListener('click', (e) => {
            e.stopPropagation();
            selectStation(station, marker, state.inputMap);
        });
        
        state.stationMarkerMap[station.id] = marker;
    });
    
    Object.keys(state.stationMarkerMap).forEach((markerId) => {
        if (!currentIds.has(markerId)) {
            removeMarker(state.stationMarkerMap[markerId]);
            delete state.stationMarkerMap[markerId];
        }
    });
}

// ============================================
// STATION SELECTION
// ============================================

// Track currently selected station
let selectedStationId = null;
let selectedStationPopup = null;

function selectStation(station, marker, map) {
    // First, deselect any previous marker (remove class)
    if (selectedStationId && state.stationMarkerMap[selectedStationId]) {
        const prevMarker = state.stationMarkerMap[selectedStationId];
        const prevMarkerDiv = prevMarker.getElement()?.querySelector('.station-marker');
        if (prevMarkerDiv) {
            prevMarkerDiv.classList.remove('selected');
        }
    }
    
    // Close any existing popup without triggering deselection
    if (selectedStationPopup) {
        // Remove the close listener first to prevent interference
        selectedStationPopup.off('close');
        selectedStationPopup.remove();
        selectedStationPopup = null;
    }
    
    // Mark this station as selected
    selectedStationId = station.id;
    
    // Get the marker element and add selected class (25% bigger)
    const markerEl = marker.getElement();
    const markerDiv = markerEl.querySelector('.station-marker');
    if (markerDiv) {
        markerDiv.classList.add('selected');
    }
    
    // Zoom in and center on station
    map.flyTo({
        center: [station.lng, station.lat],
        zoom: 14,
        duration: 800,
        essential: true
    });
    
    // Build popup content - horizontal layout matching design
    const brandLogo = station.type === 'flyingj' ? 'flyingJ-logoPNG.png' : 'pilot-logoPNG.png';
    const stationNumber = station.stationNumber || 'N/A';
    const address = station.address || 'Address unavailable';
    
    // Create Apple Maps and Google Maps URLs
    const appleMapsUrl = `https://maps.apple.com/?q=${encodeURIComponent(station.name + ' #' + stationNumber)}&ll=${station.lat},${station.lng}`;
    const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${station.lat},${station.lng}`;
    
    const popupContent = `
        <div class="station-popup-horizontal">
            <div class="popup-left">
                <div class="popup-logo-row">
                    <img src="assets/${brandLogo}" alt="${station.name}" class="popup-logo">
                    <span class="popup-station-number">#${stationNumber}</span>
                </div>
                <div class="popup-address">${address}</div>
            </div>
            <div class="popup-right">
                <a href="${appleMapsUrl}" target="_blank" class="popup-btn apple-btn">Apple Maps</a>
                <a href="${googleMapsUrl}" target="_blank" class="popup-btn google-btn">Google Maps</a>
            </div>
        </div>
    `;
    
    // Create and show popup BELOW the marker with gap (anchor: 'top' makes it appear below)
    selectedStationPopup = new mapboxgl.Popup({
        offset: [0, 15],
        closeButton: false,
        closeOnClick: false,
        maxWidth: '400px',
        className: 'station-popup-container',
        anchor: 'top'
    })
        .setLngLat([station.lng, station.lat])
        .setHTML(popupContent)
        .addTo(map);
    
    console.log(`📍 Selected: ${station.name} #${stationNumber}`);
}

function deselectCurrentStation() {
    if (selectedStationId && state.stationMarkerMap[selectedStationId]) {
        const marker = state.stationMarkerMap[selectedStationId];
        const markerEl = marker.getElement();
        const markerDiv = markerEl?.querySelector('.station-marker');
        
        if (markerDiv) {
            markerDiv.classList.remove('selected');
        }
    }
    
    selectedStationId = null;
    
    if (selectedStationPopup) {
        selectedStationPopup.remove();
        selectedStationPopup = null;
    }
}

// Track selected fuel stop on results map
let selectedFuelStopId = null;
let selectedFuelStopPopup = null;

function selectFuelStop(stop, marker, map) {
    // First, deselect any previous marker (remove class)
    if (selectedFuelStopId && state.resultsMarkers) {
        const prevMarker = state.resultsMarkers.find(m => m._stopId === selectedFuelStopId);
        if (prevMarker) {
            const prevMarkerDiv = prevMarker.getElement()?.querySelector('.station-marker');
            if (prevMarkerDiv) {
                prevMarkerDiv.classList.remove('selected');
            }
        }
    }
    
    // Remove highlight from any previously highlighted card
    document.querySelectorAll('.fuel-card.highlighted').forEach(card => {
        card.classList.remove('highlighted');
    });
    
    // Close any existing popup without triggering deselection
    if (selectedFuelStopPopup) {
        selectedFuelStopPopup.off('close');
        selectedFuelStopPopup.remove();
        selectedFuelStopPopup = null;
    }
    
    // Mark this stop as selected
    selectedFuelStopId = marker._stopId;
    
    // Get the marker element and add selected class (25% bigger)
    const markerEl = marker.getElement();
    const markerDiv = markerEl.querySelector('.station-marker');
    if (markerDiv) {
        markerDiv.classList.add('selected');
    }
    
    // Zoom in and center on stop
    map.flyTo({
        center: [stop.coords.lng, stop.coords.lat],
        zoom: 14,
        duration: 800,
        essential: true
    });
    
    // Build popup content - horizontal layout matching design
    const brandLogo = stop.logo === 'flyingj' ? 'flyingJ-logoPNG.png' : 'pilot-logoPNG.png';
    const stationNumber = stop.stationNumber || 'N/A';
    const address = stop.address || `${stop.city}, ${stop.state}`;
    
    // Create Apple Maps and Google Maps URLs
    const appleMapsUrl = `https://maps.apple.com/?q=${encodeURIComponent(stop.chain + ' #' + stationNumber)}&ll=${stop.coords.lat},${stop.coords.lng}`;
    const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.coords.lat},${stop.coords.lng}`;
    
    const popupContent = `
        <div class="station-popup-horizontal">
            <div class="popup-left">
                <div class="popup-logo-row">
                    <img src="assets/${brandLogo}" alt="${stop.chain}" class="popup-logo">
                    <span class="popup-station-number">#${stationNumber}</span>
                </div>
                <div class="popup-address">${address}</div>
            </div>
            <div class="popup-right">
                <a href="${appleMapsUrl}" target="_blank" class="popup-btn apple-btn">Apple Maps</a>
                <a href="${googleMapsUrl}" target="_blank" class="popup-btn google-btn">Google Maps</a>
            </div>
        </div>
    `;
    
    // Create and show popup BELOW the marker with gap (anchor: 'top' makes it appear below)
    selectedFuelStopPopup = new mapboxgl.Popup({
        offset: [0, 15],
        closeButton: false,
        closeOnClick: false,
        maxWidth: '400px',
        className: 'station-popup-container',
        anchor: 'top'
    })
        .setLngLat([stop.coords.lng, stop.coords.lat])
        .setHTML(popupContent)
        .addTo(map);
    
    // Scroll to the corresponding card and highlight it
    const fuelCard = document.querySelector(`.fuel-card[data-station-number="${stationNumber}"]`);
    if (fuelCard) {
        // Scroll the card into view
        fuelCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Add highlight animation
        fuelCard.classList.add('highlighted');
        
        // Remove highlight after animation completes
        setTimeout(() => {
            fuelCard.classList.remove('highlighted');
        }, 2000);
    }
    
    console.log(`📍 Selected Stop: ${stop.chain} #${stationNumber}`);
}

function deselectFuelStop() {
    // Find and deselect the marker
    if (selectedFuelStopId && state.resultsMarkers) {
        const marker = state.resultsMarkers.find(m => m._stopId === selectedFuelStopId);
        if (marker) {
            const markerEl = marker.getElement();
            const markerDiv = markerEl?.querySelector('.station-marker');
            if (markerDiv) {
                markerDiv.classList.remove('selected');
            }
        }
    }
    
    selectedFuelStopId = null;
    
    if (selectedFuelStopPopup) {
        selectedFuelStopPopup.remove();
        selectedFuelStopPopup = null;
    }
}

async function loadStationsFromCSV(force = false) {
    if (state.csvFetchInProgress) return;
    state.csvFetchInProgress = true;
    try {
        showLoading('Loading Pilot & Flying J stations...');
        console.log('📂 Fetching CSV file...');
        
        // Add cache-busting query param to force fresh fetch
        const response = await fetch('assets/all_locations.csv?v=' + Date.now());
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const text = await response.text();
        console.log(`📄 CSV loaded: ${text.length} characters`);
        
        const parsed = parseStationsCSV(text);
        console.log(`✅ Parsed ${parsed.length} stations`);
        
        if (parsed.length) {
            cacheStations(parsed);
            setStations(parsed);
            console.log('🗺️ Stations loaded and ready');
        } else {
            console.error('❌ No stations were parsed from CSV');
            showError('No stations parsed from CSV - check console for details');
        }
    } catch (err) {
        console.error('❌ CSV load failed:', err);
        console.error('Error details:', err.message, err.stack);
        showError('Failed to load station dataset - check console (F12)');
    } finally {
        hideLoading();
        state.csvFetchInProgress = false;
    }
}

function setStations(stations = []) {
    // Filter out stations with invalid coordinates first
    const validStations = stations.filter(station => 
        Number.isFinite(station.lat) && Number.isFinite(station.lng)
    );
    
    console.log(`📍 Valid stations: ${validStations.length} / ${stations.length}`);
    
    state.stations = validStations.map((station, index) => {
        const type = station.type || ((station.name || '').toLowerCase().includes('flying') ? 'flyingj' : 'pilot');
        
        // Get price using FuelPrices module if available, otherwise estimate
        let price;
        if (window.FuelPrices && typeof window.FuelPrices.getStationPrice === 'function') {
            price = window.FuelPrices.getStationPrice(station);
        } else {
            price = typeof station.price === 'number' ? station.price : estimateFuelPrice(station.lat, station.lng, station.name);
        }
        
        return {
            ...station,
            id: station.id || `station-${index}`,
            type,
            price,
            address: station.address || buildFallbackAddress(station)
        };
    });
    state.stationsLoaded = true;
    clearStationMarkers();
    
    try {
        displayStationsOnMap();
    } catch (displayErr) {
        console.error('Error displaying stations on map:', displayErr);
    }
}

function clearStationMarkers() {
    if (!state.stationMarkerMap) return;
    Object.values(state.stationMarkerMap).forEach(removeMarker);
    state.stationMarkerMap = {};
}

function getCachedStations() {
    try {
        const cached = localStorage.getItem(STATIONS_CACHE_KEY);
        if (!cached) return null;
        const payload = JSON.parse(cached);
        if (!payload.timestamp || Date.now() - payload.timestamp > STATIONS_CACHE_TTL) {
            return null;
        }
        return payload.stations || null;
    } catch (error) {
        return null;
    }
}

function cacheStations(stations) {
    try {
        localStorage.setItem(STATIONS_CACHE_KEY, JSON.stringify({
            timestamp: Date.now(),
            stations
        }));
    } catch (error) {
        console.warn('Unable to cache stations', error);
    }
}

function parseOverpassStation(element) {
    if (!element) return null;
    const tags = element.tags || {};
    const lat = element.lat || (element.center && element.center.lat);
    const lng = element.lon || (element.center && element.center.lon);
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    
    const brandRaw = (tags.brand || tags.name || '').toLowerCase();
    const isFlyingJ = brandRaw.includes('flying');
    const name = isFlyingJ ? 'Flying J' : 'Pilot';
    
    return {
        id: `osm-${element.type}-${element.id}`,
        name,
        stationNumber: tags.ref || tags['ref:pilot'] || null,
        lat,
        lng,
        city: tags['addr:city'] || '',
        state: tags['addr:state'] || '',
        postalCode: tags['addr:postcode'] || '',
        exit: tags['ref:exit'] ? `Exit ${tags['ref:exit']}` : (tags.ref ? `Exit ${tags.ref}` : 'On route'),
        address: formatAddressFromTags(tags),
        price: parseFloat(tags['fuel:diesel:price'] || tags['fuel:gasoline:price']) || null,
        type: isFlyingJ ? 'flyingj' : 'pilot'
    };
}

function parseStationsCSV(text) {
    try {
        // Parse CSV with multiline quoted fields support
        const records = parseCSVWithMultiline(text);
        console.log(`📊 CSV Parser: Found ${records.length} raw records`);
        
        if (records.length <= 1) {
            console.error('❌ CSV has no data records (only header or empty)');
            return [];
        }
        
        // Trim header values and find indices
        const header = records[0].map(h => h.trim());
        console.log('CSV Header:', header);
    
    const idx = {
        store: header.findIndex(h => h === 'Store #'),
        name: header.findIndex(h => h === 'Name'),
        address: header.findIndex(h => h === 'Address'),
        latlng: header.findIndex(h => h === 'Latitude/Longitude'),
        interstate: header.findIndex(h => h === 'Interstate')
    };
    console.log('Column indices:', idx);
    
    const stations = [];
    for (let i = 1; i < records.length; i++) {
        const cols = records[i];
        if (!cols || cols.length < 6) continue;
        
        const num = (cols[idx.store] || '').trim();
        const name = (cols[idx.name] || '').trim();
        const addressRaw = removeCountryFromAddress((cols[idx.address] || '').trim());
        const { street, city, state, postal } = parseAddressParts(addressRaw);
        const interstate = (cols[idx.interstate] || 'On route').trim();
        const latlng = (cols[idx.latlng] || '').trim();
        
        // Debug first few records
        if (i <= 3) {
            console.log(`Record ${i}: Store#=${num}, Name=${name}, Interstate=${interstate}, LatLng=${latlng}`);
        }
        
        const [latStr, lngStr] = latlng.split(',').map(s => s.trim());
        const lat = parseFloat(latStr);
        const lng = parseFloat(lngStr);
        
        if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
        if (!num) continue; // Skip rows without store number
        
        const isFlyingJ = name.toLowerCase().includes('flying');
        stations.push({
            id: `csv-${num}`,
            number: num,
            stationNumber: num,
            name: isFlyingJ ? 'Flying J' : 'Pilot',
            type: isFlyingJ ? 'flyingj' : 'pilot',
            address: addressRaw,
            city,
            state,
            postalCode: postal,
            lat, lng,
            exit: interstate,
            interstate: interstate,
            price: estimateFuelPrice(lat, lng, name)
        });
    }
    console.log(`✅ Parsed ${stations.length} stations from CSV`);
    
    // Debug: find station #30 and #156
    const s30 = stations.find(s => s.stationNumber === '30');
    const s156 = stations.find(s => s.stationNumber === '156');
    const s708 = stations.find(s => s.stationNumber === '708');
    if (s30) console.log('Station #30:', s30);
    if (s156) console.log('Station #156:', s156);
    if (s708) console.log('Station #708 (Carlisle PA):', s708);
    
    return stations;
    } catch (parseError) {
        console.error('❌ Error parsing CSV:', parseError);
        console.error('Parse error details:', parseError.message, parseError.stack);
        return [];
    }
}

function parseCSVWithMultiline(text) {
    // Robust CSV parser that handles multiline quoted fields
    const records = [];
    let currentRecord = [];
    let currentField = '';
    let inQuotes = false;
    let i = 0;
    
    while (i < text.length) {
        const char = text[i];
        const nextChar = text[i + 1];
        
        if (inQuotes) {
            if (char === '"') {
                if (nextChar === '"') {
                    // Escaped quote ""
                    currentField += '"';
                    i += 2;
                    continue;
                } else {
                    // End of quoted field
                    inQuotes = false;
                    i++;
                    continue;
                }
            } else {
                // Any character inside quotes (including newlines)
                currentField += char;
                i++;
                continue;
            }
        }
        
        // Not in quotes
        if (char === '"') {
            // Start of quoted field
            inQuotes = true;
            i++;
        } else if (char === ',') {
            // End of field
            currentRecord.push(currentField.trim());
            currentField = '';
            i++;
        } else if (char === '\r' && nextChar === '\n') {
            // Windows line ending - end of record
            currentRecord.push(currentField.trim());
            if (currentRecord.length > 0 && currentRecord[0]) {
                records.push(currentRecord);
            }
            currentRecord = [];
            currentField = '';
            i += 2;
        } else if (char === '\n') {
            // Unix line ending - end of record
            currentRecord.push(currentField.trim());
            if (currentRecord.length > 0 && currentRecord[0]) {
                records.push(currentRecord);
            }
            currentRecord = [];
            currentField = '';
            i++;
        } else if (char === '\r') {
            // Old Mac line ending - end of record
            currentRecord.push(currentField.trim());
            if (currentRecord.length > 0 && currentRecord[0]) {
                records.push(currentRecord);
            }
            currentRecord = [];
            currentField = '';
            i++;
        } else {
            currentField += char;
            i++;
        }
    }
    
    // Don't forget the last field and record
    if (currentField || currentRecord.length) {
        currentRecord.push(currentField.trim());
        if (currentRecord.length > 0 && currentRecord[0]) {
            records.push(currentRecord);
        }
    }
    
    console.log(`CSV Parser: Found ${records.length} records`);
    if (records.length > 0) {
        console.log('First record columns:', records[0].length, records[0]);
        if (records.length > 1) {
            console.log('Second record columns:', records[1].length, 'Store#:', records[1][0]);
        }
    }
    
    return records;
}


function parseAddressParts(address) {
    // Expected format: "street, city, ST, zip"
    const parts = address.split(',').map(p => p.trim()).filter(Boolean);
    let street = '';
    let city = '';
    let state = '';
    let postal = '';
    if (parts.length >= 1) street = parts[0];
    if (parts.length >= 2) city = parts[1];
    if (parts.length >= 3) {
        const stateZip = parts[2].split(' ').filter(Boolean);
        if (stateZip.length >= 1) state = stateZip[0];
        if (stateZip.length >= 2) postal = stateZip.slice(1).join(' ');
    }
    if (!postal && parts.length >= 4) {
        postal = parts[3];
    }
    return { street, city, state, postal };
}

function formatAddressFromTags(tags) {
    if (!tags) return '';
    if (tags['addr:full']) return tags['addr:full'];
    
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ').trim();
    const cityState = [tags['addr:city'], tags['addr:state']].filter(Boolean).join(', ').trim();
    const postal = tags['addr:postcode'] || '';
    
    const parts = [];
    if (street) parts.push(street);
    if (cityState) parts.push(cityState);
    if (postal) {
        const last = parts.pop() || '';
        parts.push(`${last} ${postal}`.trim());
    }
    
    return parts.filter(Boolean).join(', ');
}

function estimateFuelPrice(lat, lng, brand = '', stateCode = '') {
    // Use FuelPrices module if available for regional pricing
    if (window.FuelPrices && stateCode) {
        return window.FuelPrices.getRegionalPrice(stateCode);
    }
    
    // Fallback: estimate based on region
    // West coast is more expensive, midwest/south is cheaper
    let basePrice = 3.50;
    
    // Longitude-based adjustment (west = more expensive)
    if (lng < -115) basePrice += 0.80; // West coast (CA, OR, WA)
    else if (lng < -100) basePrice += 0.20; // Mountain states
    else if (lng < -85) basePrice -= 0.20; // Midwest/South
    else basePrice += 0.10; // East coast
    
    // Small brand variance
    const brandVariance = brand.toLowerCase().includes('flying') ? -0.05 : 0;
    
    return parseFloat((basePrice + brandVariance).toFixed(2));
}

function findNearestStationRecord(lat, lng) {
    if (!state.stations || !state.stations.length) return null;
    let best = null;
    let bestDist = Infinity;
    state.stations.forEach((station) => {
        if (!station.lat || !station.lng) return;
        const dist = haversineDistance(lat, lng, station.lat, station.lng);
        if (dist < bestDist) {
            bestDist = dist;
            best = station;
        }
    });
    if (best && bestDist <= 1) {
        return { station: best, distance: bestDist };
    }
    return null;
}

function hasDetailedAddress(address) {
    if (!address) return false;
    return /\d/.test(address) && address.includes(',');
}

function initializeResultsMap() {
    if (!window.mapboxgl) return;
    
    if (!state.resultsMap) {
        state.resultsMap = new mapboxgl.Map({
            container: 'results-map',
            style: 'mapbox://styles/mapbox/streets-v12',
            center: { lat: CONFIG.defaultCenter[0], lng: CONFIG.defaultCenter[1] },
            zoom: CONFIG.defaultZoom,
            attributionControl: true
        });
        
        state.resultsMapReady = false;
        state.resultsMap.on('load', () => {
            state.resultsMapReady = true;
            if (state.pendingRoute) {
                const { routeData, fuelStops } = state.pendingRoute;
                state.pendingRoute = null;
                displayRouteOnMap(routeData, fuelStops);
            }
        });
        
        document.getElementById('results-zoom-in').addEventListener('click', () => {
            if (!state.resultsMap) return;
            state.resultsMap.zoomTo(state.resultsMap.getZoom() + 1);
        });
        
        document.getElementById('results-zoom-out').addEventListener('click', () => {
            if (!state.resultsMap) return;
            state.resultsMap.zoomTo(state.resultsMap.getZoom() - 1);
        });
        
        document.getElementById('results-locate').addEventListener('click', () => {
            centerOnUserLocation(state.resultsMap, 10);
        });
        
        // Click on map to deselect fuel stop
        state.resultsMap.on('click', (e) => {
            const target = e.originalEvent?.target;
            if (target && !target.closest('.station-marker')) {
                deselectFuelStop();
            }
        });
    } else {
        state.resultsMap.setCenter({ lat: CONFIG.defaultCenter[0], lng: CONFIG.defaultCenter[1] });
        state.resultsMap.setZoom(CONFIG.defaultZoom);
    }
}

// ============================================
// EVENT LISTENERS
// ============================================

function setupEventListeners() {
    // Attach Mapbox listeners once
    if (state.inputMap && !state.inputMapListenersAttached) {
        state.inputMap.on('moveend', displayStationsOnMap);
        state.inputMapListenersAttached = true;
    }
    
    // Start ZIP button - shows popup with My Location option
    document.getElementById('start-zip-btn').addEventListener('click', () => {
        state.currentZipType = 'start';
        showZipPopup();
    });
    
    // End ZIP button - opens direct manual entry (no My Location option)
    document.getElementById('end-zip-btn').addEventListener('click', () => {
        state.currentZipType = 'end';
        showEndZipPopup();
    });
    
    // Start ZIP popup options
    document.getElementById('popup-manual').addEventListener('click', () => {
        hideZipPopup();
        showZipEntryPopup();
    });
    
    document.getElementById('popup-location').addEventListener('click', () => {
        hideZipPopup();
        getZipFromLocation();
    });
    
    // Start ZIP entry popup
    document.getElementById('zip-entry-cancel').addEventListener('click', hideZipEntryPopup);
    document.getElementById('zip-entry-confirm').addEventListener('click', confirmZipEntry);
    document.getElementById('zip-entry-input').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5);
    });
    document.getElementById('zip-entry-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmZipEntry();
    });
    
    // End ZIP entry popup (manual only)
    document.getElementById('end-zip-entry-cancel').addEventListener('click', hideEndZipPopup);
    document.getElementById('end-zip-entry-confirm').addEventListener('click', confirmEndZipEntry);
    document.getElementById('end-zip-entry-input').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5);
    });
    document.getElementById('end-zip-entry-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmEndZipEntry();
    });
    
    // Param boxes - wheel pickers
    document.getElementById('tank-box').addEventListener('click', () => {
        showWheelPicker('tank');
    });
    
    document.getElementById('gallons-box').addEventListener('click', () => {
        showWheelPicker('gallons');
    });
    
    document.getElementById('mpg-box').addEventListener('click', () => {
        showWheelPicker('mpg');
    });
    
    // Wheel picker controls
    document.getElementById('wheel-cancel').addEventListener('click', hideWheelPicker);
    document.getElementById('wheel-done').addEventListener('click', confirmWheelSelection);
    
    // Close popups on overlay click
    document.getElementById('zip-popup').addEventListener('click', (e) => {
        if (e.target === document.getElementById('zip-popup')) {
            hideZipPopup();
        }
    });
    
    document.getElementById('zip-entry-popup').addEventListener('click', (e) => {
        if (e.target === document.getElementById('zip-entry-popup')) {
            hideZipEntryPopup();
        }
    });
    
    document.getElementById('end-zip-popup').addEventListener('click', (e) => {
        if (e.target === document.getElementById('end-zip-popup')) {
            hideEndZipPopup();
        }
    });
    
    document.getElementById('wheel-popup').addEventListener('click', (e) => {
        if (e.target === document.getElementById('wheel-popup')) {
            hideWheelPicker();
        }
    });
    
    // Calculate button
    document.getElementById('calculate-btn').addEventListener('click', handleCalculate);
    
    // Back button
    document.getElementById('back-btn').addEventListener('click', handleBack);
}

// ============================================
// ZIP POPUP HANDLING
// ============================================

function showZipPopup() {
    document.getElementById('zip-popup').classList.remove('hidden');
}

function hideZipPopup() {
    document.getElementById('zip-popup').classList.add('hidden');
}

function showZipEntryPopup() {
    const title = state.currentZipType === 'start' ? 'Enter Start ZIP' : 'Enter End ZIP';
    document.getElementById('zip-entry-title').textContent = title;
    document.getElementById('zip-entry-input').value = '';
    document.getElementById('zip-entry-popup').classList.remove('hidden');
    setTimeout(() => {
        document.getElementById('zip-entry-input').focus();
    }, 100);
}

function hideZipEntryPopup() {
    document.getElementById('zip-entry-popup').classList.add('hidden');
}

function confirmZipEntry() {
    const zip = document.getElementById('zip-entry-input').value.trim();
    if (zip.length !== 5) {
        showError('Please enter a valid 5-digit ZIP code');
        return;
    }
    
    // This is only for Start ZIP now
    state.startZip = zip;
    document.getElementById('start-zip').value = zip;
    document.getElementById('start-zip-text').textContent = zip;
    document.getElementById('start-zip-btn').classList.add('has-value');
    
    hideZipEntryPopup();
}

// End ZIP popup functions (manual entry only, no My Location)
function showEndZipPopup() {
    document.getElementById('end-zip-entry-input').value = '';
    document.getElementById('end-zip-popup').classList.remove('hidden');
    setTimeout(() => {
        document.getElementById('end-zip-entry-input').focus();
    }, 100);
}

function hideEndZipPopup() {
    document.getElementById('end-zip-popup').classList.add('hidden');
}

function confirmEndZipEntry() {
    const zip = document.getElementById('end-zip-entry-input').value.trim();
    if (zip.length !== 5) {
        showError('Please enter a valid 5-digit ZIP code');
        return;
    }
    
    state.endZip = zip;
    document.getElementById('end-zip').value = zip;
    document.getElementById('end-zip-text').textContent = zip;
    document.getElementById('end-zip-btn').classList.add('has-value');
    
    hideEndZipPopup();
}

async function getZipFromLocation() {
    if (!navigator.geolocation) {
        showError('Geolocation is not supported by your browser');
        return;
    }
    
    showLoading('Detecting your ZIP...');
    
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            try {
                const { latitude, longitude } = position.coords;
                const result = await reverseGeocodeZip(latitude, longitude);
                
                if (result && result.zip) {
                    const cleanZip = result.zip.split('-')[0];
                    
                    if (state.currentZipType === 'start') {
                        state.startZip = cleanZip;
                        state.startCoords = { lat: latitude, lng: longitude };
                        document.getElementById('start-zip').value = cleanZip;
                        document.getElementById('start-zip-text').textContent = cleanZip;
                        document.getElementById('start-zip-btn').classList.add('has-value');
                    } else {
                        state.endZip = cleanZip;
                        state.endCoords = { lat: latitude, lng: longitude };
                        document.getElementById('end-zip').value = cleanZip;
                        document.getElementById('end-zip-text').textContent = cleanZip;
                        document.getElementById('end-zip-btn').classList.add('has-value');
                    }
                    
                    if (state.inputMap) {
                        state.inputMap.panTo({ lat: latitude, lng: longitude });
                    }
                } else {
                    showError('Could not determine ZIP code for this location');
                }
            } catch (error) {
                console.error('Reverse geocoding error:', error);
                showError('Failed to get ZIP code from location');
            } finally {
                hideLoading();
            }
        },
        (error) => {
            hideLoading();
            console.error('Geolocation error:', error);
            showError('Unable to get your location. Please enable location services.');
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ============================================
// WHEEL PICKER
// ============================================

function showWheelPicker(type) {
    state.currentWheelType = type;
    const config = CONFIG.wheelConfig[type];
    const wheelScroll = document.getElementById('wheel-scroll');
    
    // Set title
    const titles = { tank: 'Tank Size', gallons: 'Gallons Now', mpg: 'MPG' };
    document.getElementById('wheel-title').textContent = titles[type];
    
    // Generate wheel items
    const items = [];
    for (let val = config.min; val <= config.max; val += config.step) {
        const displayVal = config.step < 1 ? val.toFixed(1) : val;
        const label = config.unit ? `${displayVal} ${config.unit}` : displayVal;
        items.push({ value: val, label });
    }
    
    wheelScroll.innerHTML = items.map(item => 
        `<div class="wheel-item" data-value="${item.value}">${item.label}</div>`
    ).join('');
    
    // Get current value
    let currentValue;
    if (type === 'tank') {
        currentValue = parseInt(document.getElementById('tank-size').value);
    } else if (type === 'gallons') {
        currentValue = parseInt(document.getElementById('current-gallons').value);
    } else {
        currentValue = parseFloat(document.getElementById('mpg').value);
    }
    
    // Scroll to current value
    setTimeout(() => {
        const items = wheelScroll.querySelectorAll('.wheel-item');
        items.forEach(item => {
            const itemValue = parseFloat(item.dataset.value);
            if (Math.abs(itemValue - currentValue) < 0.05) {
                item.scrollIntoView({ block: 'center', behavior: 'instant' });
                item.classList.add('selected');
            }
        });
        
        // Add scroll listener for selection
        wheelScroll.addEventListener('scroll', handleWheelScroll);
    }, 50);
    
    document.getElementById('wheel-popup').classList.remove('hidden');
}

function handleWheelScroll() {
    const wheelScroll = document.getElementById('wheel-scroll');
    const items = wheelScroll.querySelectorAll('.wheel-item');
    const containerRect = wheelScroll.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;
    
    let closestItem = null;
    let closestDistance = Infinity;
    
    items.forEach(item => {
        const rect = item.getBoundingClientRect();
        const itemCenterY = rect.top + rect.height / 2;
        const distance = Math.abs(itemCenterY - centerY);
        
        if (distance < closestDistance) {
            closestDistance = distance;
            closestItem = item;
        }
        
        item.classList.remove('selected');
    });
    
    if (closestItem) {
        closestItem.classList.add('selected');
    }
}

function hideWheelPicker() {
    document.getElementById('wheel-popup').classList.add('hidden');
    const wheelScroll = document.getElementById('wheel-scroll');
    wheelScroll.removeEventListener('scroll', handleWheelScroll);
}

function confirmWheelSelection() {
    const selectedItem = document.querySelector('.wheel-item.selected');
    if (!selectedItem) {
        hideWheelPicker();
        return;
    }
    
    const value = selectedItem.dataset.value;
    const type = state.currentWheelType;
    
    if (type === 'tank') {
        document.getElementById('tank-size').value = value;
        document.getElementById('tank-value').textContent = value;
    } else if (type === 'gallons') {
        document.getElementById('current-gallons').value = value;
        document.getElementById('gallons-value').textContent = value;
    } else if (type === 'mpg') {
        document.getElementById('mpg').value = value;
        document.getElementById('mpg-value').textContent = parseFloat(value).toFixed(1);
    }
    
    hideWheelPicker();
}

// ============================================
// MAIN CALCULATION HANDLER
// ============================================

async function handleCalculate() {
    const startZip = document.getElementById('start-zip').value.trim();
    const endZip = document.getElementById('end-zip').value.trim();
    const currentGallons = parseInt(document.getElementById('current-gallons').value);
    const tankSize = parseInt(document.getElementById('tank-size').value);
    const mpg = parseFloat(document.getElementById('mpg').value);
    
    // Validation
    if (!startZip || startZip.length !== 5) {
        showError('Please select a start ZIP code');
        return;
    }
    
    if (!endZip || endZip.length !== 5) {
        showError('Please select an end ZIP code');
        return;
    }
    
    if (currentGallons > tankSize) {
        showError('Current gallons cannot exceed tank size');
        return;
    }
    
    showLoading();
    
    try {
        // Geocode ZIP codes
        const [startCoords, endCoords] = await Promise.all([
            geocodeZip(startZip),
            geocodeZip(endZip)
        ]);
        
        if (!startCoords || !endCoords) {
            throw new Error('Could not find one or both ZIP codes');
        }
        
        state.startCoords = startCoords;
        state.endCoords = endCoords;
        
        // Calculate route
        const routeData = await calculateRoute(startCoords, endCoords);
        state.routeData = routeData;
        
        // Calculate fuel stops for the ENTIRE route
        const { stops: fuelStops, finalFuel } = calculateFuelStops(routeData, currentGallons, tankSize, mpg, endCoords);
        state.fuelStops = fuelStops;
        state.tripSummary = {
            finalFuel: parseFloat(Math.min(tankSize, finalFuel).toFixed(1)),
            totalSavings: fuelStops.reduce((sum, stop) => sum + (stop.savings || 0), 0)
        };
        await enrichFuelStops(fuelStops);
        
        // Switch to results view
        showResultsView();
        
        // Initialize results map and display route
        setTimeout(() => {
            initializeResultsMap();
            displayRouteOnMap(routeData, fuelStops);
            renderFuelStopCards(fuelStops);
        }, 100);
        
    } catch (error) {
        console.error('Calculation error:', error);
        showError(error.message || 'Failed to calculate route. Please try again.');
    } finally {
        hideLoading();
    }
}

// ============================================
// GEOCODING
// ============================================

async function geocodeZip(zip) {
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&limit=1`,
            { headers: { 'User-Agent': 'FuelPlannerApp/1.0' } }
        );
        
        const data = await response.json();
        
        if (data && data.length > 0) {
            return {
                lat: parseFloat(data[0].lat),
                lng: parseFloat(data[0].lon),
                displayName: data[0].display_name,
                state: extractStateFromDisplayName(data[0].display_name)
            };
        }
        
        return getApproximateCoords(zip);
    } catch (error) {
        console.error('Geocoding error:', error);
        return getApproximateCoords(zip);
    }
}

function extractStateFromDisplayName(displayName) {
    // Try to extract state abbreviation from display name
    const stateMatch = displayName.match(/,\s*([A-Z]{2})\s*,/);
    if (stateMatch) return stateMatch[1];
    
    // Common state names to abbreviations
    const stateMap = {
        'California': 'CA', 'Washington': 'WA', 'Oregon': 'OR', 'Nevada': 'NV',
        'Arizona': 'AZ', 'Utah': 'UT', 'Colorado': 'CO', 'New Mexico': 'NM',
        'Texas': 'TX', 'Oklahoma': 'OK', 'Kansas': 'KS', 'Nebraska': 'NE',
        'South Dakota': 'SD', 'North Dakota': 'ND', 'Montana': 'MT', 'Wyoming': 'WY',
        'Idaho': 'ID', 'Minnesota': 'MN', 'Iowa': 'IA', 'Missouri': 'MO',
        'Arkansas': 'AR', 'Louisiana': 'LA', 'Mississippi': 'MS', 'Alabama': 'AL',
        'Tennessee': 'TN', 'Kentucky': 'KY', 'Georgia': 'GA', 'Florida': 'FL',
        'South Carolina': 'SC', 'North Carolina': 'NC', 'Virginia': 'VA',
        'West Virginia': 'WV', 'Maryland': 'MD', 'Delaware': 'DE', 'New Jersey': 'NJ',
        'Pennsylvania': 'PA', 'New York': 'NY', 'Connecticut': 'CT', 'Rhode Island': 'RI',
        'Massachusetts': 'MA', 'Vermont': 'VT', 'New Hampshire': 'NH', 'Maine': 'ME',
        'Ohio': 'OH', 'Indiana': 'IN', 'Illinois': 'IL', 'Michigan': 'MI',
        'Wisconsin': 'WI'
    };
    
    for (const [name, abbr] of Object.entries(stateMap)) {
        if (displayName.includes(name)) return abbr;
    }
    
    return null;
}

function getApproximateCoords(zip) {
    const firstDigit = zip[0];
    const zipZones = {
        '0': { lat: 42.3601, lng: -71.0589, state: 'MA' },
        '1': { lat: 41.7658, lng: -72.6734, state: 'CT' },
        '2': { lat: 38.9072, lng: -77.0369, state: 'DC' },
        '3': { lat: 33.7490, lng: -84.3880, state: 'GA' },
        '4': { lat: 39.0997, lng: -84.5126, state: 'OH' },
        '5': { lat: 44.9778, lng: -93.2650, state: 'MN' },
        '6': { lat: 41.8781, lng: -87.6298, state: 'IL' },
        '7': { lat: 29.7604, lng: -95.3698, state: 'TX' },
        '8': { lat: 39.7392, lng: -104.9903, state: 'CO' },
        '9': { lat: 37.7749, lng: -122.4194, state: 'CA' }
    };
    
    const base = zipZones[firstDigit] || { lat: 39.8283, lng: -98.5795, state: null };
    return { ...base, displayName: `ZIP ${zip}` };
}

// ============================================
// ROUTE CALCULATION
// ============================================

async function calculateRoute(start, end) {
    try {
        const response = await fetch(
            `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`
        );
        
        const data = await response.json();
        
        if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            return {
                coordinates: route.geometry.coordinates.map(coord => [coord[1], coord[0]]),
                distance: route.distance / 1609.34,
                duration: route.duration / 3600,
                startCoords: start,
                endCoords: end
            };
        }
        
        throw new Error('No route found');
    } catch (error) {
        console.error('Routing error:', error);
        return calculateFallbackRoute(start, end);
    }
}

function calculateFallbackRoute(start, end) {
    const distance = haversineDistance(start.lat, start.lng, end.lat, end.lng);
    const duration = distance / 55;
    
    const numPoints = Math.max(20, Math.floor(distance / 10));
    const coordinates = [];
    
    for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        coordinates.push([
            start.lat + (end.lat - start.lat) * t,
            start.lng + (end.lng - start.lng) * t
        ]);
    }
    
    return { coordinates, distance, duration, startCoords: start, endCoords: end };
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// ============================================
// FUEL STOP CALCULATION - FULL ROUTE (NO LIMITS)
// ============================================

function calculateFuelStops(routeData, currentGallons, tankSize, mpg, endCoords) {
    const totalDistance = routeData.distance;
    const stops = [];
    
    // Current state tracking
    let currentFuel = currentGallons;  // Fuel in tank right now
    let currentPosition = 0;           // Miles traveled so far
    
    // Target: arrive with 3/4 tank (75%)
    const targetFuelAtDestination = tankSize * CONFIG.destinationFuelTarget;
    
    // Find all Pilot/Flying J stations along the route, sorted by distance
    const stationsAlongRoute = findStationsAlongRoute(routeData);
    
    // HIGH PRIORITY: Find where route enters CA or WA
    // These states have high fuel prices - must fill up BEFORE entering
    const highPriceStates = CONFIG.fullTankStates; // ['CA', 'WA']
    const stateBorderCrossings = findStateBorderCrossings(stationsAlongRoute, highPriceStates);
    
    // Keep track of which stations we've already used
    const usedStations = new Set();
    
    console.log(`Route: ${totalDistance.toFixed(0)} miles, Starting fuel: ${currentFuel} gal, MPG: ${mpg}`);
    console.log(`Max range per tank: ${(tankSize * mpg).toFixed(0)} miles`);
    console.log(`Stations found along route: ${stationsAlongRoute.length}`);
    console.log(`State border crossings into ${highPriceStates.join('/')}: ${stateBorderCrossings.length}`);
    
    // Main loop - continue until we can reach destination with target fuel
    while (currentPosition < totalDistance) {
        const remainingDistance = totalDistance - currentPosition;
        const currentRange = currentFuel * mpg;
        const usableRangeGallons = Math.max(0, currentFuel - CONFIG.minArrivalGallons);
        const usableRange = usableRangeGallons * mpg;
        
        // PRIORITY 1: Check if we're approaching CA/WA border
        // Find the next border crossing we haven't passed yet
        const nextBorderCrossing = stateBorderCrossings.find(
            crossing => crossing.borderDistance > currentPosition && 
                       crossing.lastStationBeforeBorder &&
                       !usedStations.has(crossing.lastStationBeforeBorder.id)
        );
        
        if (nextBorderCrossing) {
            const lastStationBeforeBorder = nextBorderCrossing.lastStationBeforeBorder;
            const distanceToLastStation = lastStationBeforeBorder.distanceFromStart - currentPosition;
            
            // Can we reach this station?
            if (distanceToLastStation > 0 && distanceToLastStation <= usableRange) {
                const fuelUsedToStation = distanceToLastStation / mpg;
                const fuelAtStation = currentFuel - fuelUsedToStation;
                
                // FILL TO FULL before entering high-price state
                const gallonsToAdd = Math.max(0, Math.round(tankSize - fuelAtStation));
                
                if (gallonsToAdd > 0) {
                    console.log(`⚠️ PRIORITY STOP: Fill up before entering ${nextBorderCrossing.enteringState}`);
                    stops.push(createStopFromStation(
                        stops.length + 1,
                        lastStationBeforeBorder,
                        gallonsToAdd,
                        tankSize,
                        routeData,
                        fuelAtStation
                    ));
                    usedStations.add(lastStationBeforeBorder.id);
                    currentFuel = tankSize;
                    currentPosition = lastStationBeforeBorder.distanceFromStart;
                    continue;
                }
            }
        }
        
        // Calculate fuel we'll have when we reach destination
        const fuelAtDestination = currentFuel - (remainingDistance / mpg);
        
        // PRIORITY 2: Can we reach destination with enough fuel?
        // (Lower priority than filling before CA/WA)
        if (fuelAtDestination >= targetFuelAtDestination) {
            console.log(`Can reach destination with ${fuelAtDestination.toFixed(1)} gal remaining`);
            break;
        }
        
        // Can we at least reach the destination (even if below 3/4)?
        if (fuelAtDestination >= 0 && fuelAtDestination < targetFuelAtDestination) {
            // We can make it but won't have 3/4 tank - need one more stop
            // Find the best station in remaining distance
            const finalSearchMax = Math.min(
                currentPosition + usableRange,
                currentPosition + Math.max(usableRange * 0.85, 50)
            );
            const stationInRange = findBestStationInRange(
                currentPosition,
                finalSearchMax,
                stationsAlongRoute,
                usedStations
            );
            
            if (stationInRange) {
                const distanceToStation = stationInRange.distanceFromStart - currentPosition;
                const fuelUsed = distanceToStation / mpg;
                const fuelAtStation = currentFuel - fuelUsed;
                
                // Check if there's a high-price state border after this station
                const willEnterHighPriceState = stateBorderCrossings.some(
                    crossing => crossing.borderDistance > stationInRange.distanceFromStart
                );
                
                let fillTo;
                if (willEnterHighPriceState || highPriceStates.includes(stationInRange.state)) {
                    // Fill to full if we're about to enter CA/WA or if we're still outside
                    fillTo = tankSize;
                } else {
                    // Calculate how much fuel we need to reach destination with 3/4 tank
                    const distanceAfterStation = totalDistance - stationInRange.distanceFromStart;
                    const fuelNeeded = (distanceAfterStation / mpg) + targetFuelAtDestination;
                    fillTo = Math.min(tankSize, Math.ceil(fuelNeeded) + 5); // +5 buffer
                }
                
                const gallonsToAdd = Math.max(0, Math.round(fillTo - fuelAtStation));
                
                if (gallonsToAdd > 0) {
                    stops.push(createStopFromStation(
                        stops.length + 1,
                        stationInRange,
                        gallonsToAdd,
                        fillTo,
                        routeData,
                        fuelAtStation
                    ));
                    usedStations.add(stationInRange.id);
                    console.log(`Stop ${stops.length}: ${stationInRange.name} at ${stationInRange.distanceFromStart.toFixed(0)} mi, add ${gallonsToAdd} gal`);
                }
            }
            break;
        }
        
        // We cannot reach destination - need to find a fuel stop
        // Calculate safe range (stop with at least 10% tank remaining)
        const safeRange = usableRange * 0.90;
        const maxReachableDistance = currentPosition + Math.max(safeRange, 10);
        
        // Find the furthest station we can safely reach
        const nextStation = findBestStationInRange(
            currentPosition + 20,
            maxReachableDistance,
            stationsAlongRoute,
            usedStations
        );
        
        if (!nextStation) {
            // No station in narrow range - expand search to find ANY station we can reach
            console.warn(`No station found between ${currentPosition.toFixed(0)} and ${maxReachableDistance.toFixed(0)} miles - expanding search`);
            
            // Search for any reachable station (even if we arrive with low fuel)
            const expandedStation = findAnyReachableStation(
                currentPosition,
                currentFuel * mpg * 0.95,  // Use 95% of remaining range
                stationsAlongRoute,
                usedStations
            );
            
            if (expandedStation) {
                console.log(`Found station in expanded search: ${expandedStation.name} #${expandedStation.stationNumber} at ${expandedStation.distanceFromStart.toFixed(0)} mi`);
                const distToStation = expandedStation.distanceFromStart - currentPosition;
                const fuelAtStation = currentFuel - (distToStation / mpg);
                
                stops.push(createStopFromStation(
                    stops.length + 1,
                    expandedStation,
                    Math.round(tankSize - Math.max(0, fuelAtStation)),
                    tankSize,
                    routeData,
                    Math.max(0, fuelAtStation)
                ));
                usedStations.add(expandedStation.id);
                
                currentFuel = tankSize;
                currentPosition = expandedStation.distanceFromStart;
                continue;
            }
            
            // Truly no station reachable - this means we can't complete the route
            console.error('No reachable station found - route may not be completable with current fuel');
            break;
        }
        
        // Calculate fuel state at this station
        const distanceToStation = nextStation.distanceFromStart - currentPosition;
        const fuelUsedToStation = distanceToStation / mpg;
        const fuelAtStation = currentFuel - fuelUsedToStation;
        if (fuelAtStation < CONFIG.minArrivalGallons) {
            usedStations.add(nextStation.id);
            continue;
        }
        
        if (fuelAtStation < CONFIG.minArrivalGallons) {
            // We can't actually reach this station - find a closer one
            console.warn(`Cannot reach station at ${nextStation.distanceFromStart.toFixed(0)} mi with ${currentFuel.toFixed(1)} gal`);
            // Find any station we can reach
            const emergencyStation = findClosestReachableStation(
                currentPosition,
                currentRange * 0.95,
                stationsAlongRoute,
                usedStations
            );
            
            if (emergencyStation) {
                const distToEmergency = emergencyStation.distanceFromStart - currentPosition;
                const fuelAtEmergency = currentFuel - (distToEmergency / mpg);
                
                stops.push(createStopFromStation(
                    stops.length + 1,
                    emergencyStation,
                    Math.round(tankSize - fuelAtEmergency),
                    tankSize,
                    routeData,
                    fuelAtEmergency
                ));
                usedStations.add(emergencyStation.id);
                
                currentFuel = tankSize;
                currentPosition = emergencyStation.distanceFromStart;
                continue;
            }
            break;
        }
        
        // Fill up at this station - always fill to full
        // (CA/WA priority is handled at the top of the loop)
        const fillTo = tankSize;
        const gallonsToAdd = Math.max(0, Math.round(fillTo - fuelAtStation));
        
        stops.push(createStopFromStation(
            stops.length + 1,
            nextStation,
            gallonsToAdd,
            fillTo,
            routeData,
            fuelAtStation
        ));
        usedStations.add(nextStation.id);
        
        console.log(`Stop ${stops.length}: ${nextStation.name} #${nextStation.number} at ${nextStation.distanceFromStart.toFixed(0)} mi`);
        console.log(`  Arrived with ${fuelAtStation.toFixed(1)} gal, adding ${gallonsToAdd} gal, now have ${fillTo} gal`);
        
        // Update state for next iteration
        currentFuel = fillTo;
        currentPosition = nextStation.distanceFromStart;
    }
    
    const calculatedFinalFuel = currentFuel - ((totalDistance - currentPosition) / mpg);
    const finalFuel = Math.max(targetFuelAtDestination, calculatedFinalFuel);
    console.log(`Total stops planned: ${stops.length}`);
    return { stops, finalFuel };
}

// Find the CHEAPEST station within a range that we haven't used yet
// Prioritizes price over distance - only uses more expensive stations when necessary
function findBestStationInRange(minDistance, maxDistance, stations, usedStations) {
    // Get all reachable stations in range
    const reachableStations = stations.filter(station => {
        if (usedStations.has(station.id)) return false;
        if (station.distanceFromStart < minDistance) return false;
        if (station.distanceFromStart > maxDistance) return false;
        return true;
    });
    
    if (reachableStations.length === 0) return null;
    
    // Categorize by price
    const excellent = reachableStations.filter(s => s.price <= CONFIG.priceThresholds.excellent);
    const good = reachableStations.filter(s => s.price > CONFIG.priceThresholds.excellent && s.price <= CONFIG.priceThresholds.good);
    const fair = reachableStations.filter(s => s.price > CONFIG.priceThresholds.good && s.price <= CONFIG.priceThresholds.fair);
    const high = reachableStations.filter(s => s.price > CONFIG.priceThresholds.fair);
    
    // Choose from the cheapest available category
    // Within category, prefer stations that are further (to minimize total stops)
    let candidates = [];
    if (excellent.length > 0) {
        candidates = excellent;
    } else if (good.length > 0) {
        candidates = good;
    } else if (fair.length > 0) {
        candidates = fair;
    } else {
        candidates = high;
    }
    
    // Sort by: 1) Price (lowest), 2) Distance from route (closest), 3) Distance from start (furthest)
    candidates.sort((a, b) => {
        // First: compare price
        if (Math.abs(a.price - b.price) >= 0.05) {
            return a.price - b.price; // Cheapest first
        }
        
        // Same price tier - prefer station closer to the route (less detour)
        const routeDistDiff = (a.distanceFromRoute || 0) - (b.distanceFromRoute || 0);
        if (Math.abs(routeDistDiff) > 0.5) {
            return routeDistDiff; // Closer to route first
        }
        
        // Same route distance - prefer further station (minimize total stops)
        return b.distanceFromStart - a.distanceFromStart;
    });
    
    const best = candidates[0];
    if (best) {
        console.log(`Best station: ${best.name} #${best.stationNumber} - $${best.price?.toFixed(2)}, ${best.distanceFromRoute?.toFixed(1)} mi from route`);
    }
    return best || null;
}

// Find the closest station we can reach (emergency fallback)
// Prefers stations closer to the route when distances are similar
function findClosestReachableStation(currentPosition, maxRange, stations, usedStations) {
    const candidates = [];
    
    for (const station of stations) {
        if (usedStations.has(station.id)) continue;
        if (station.distanceFromStart <= currentPosition) continue;
        
        const distance = station.distanceFromStart - currentPosition;
        if (distance <= maxRange && distance > 0) {
            candidates.push({ ...station, distanceFromCurrent: distance });
        }
    }
    
    if (candidates.length === 0) return null;
    
    // Sort by distance from current position, then by distance from route
    candidates.sort((a, b) => {
        const distDiff = a.distanceFromCurrent - b.distanceFromCurrent;
        if (Math.abs(distDiff) > 10) return distDiff; // Closest first
        
        // Similar distance - prefer closer to route
        return (a.distanceFromRoute || 0) - (b.distanceFromRoute || 0);
    });
    
    return candidates[0];
}

// Find ANY station we can reach, prioritizing by: 1) price, 2) proximity to route, 3) distance
function findAnyReachableStation(currentPosition, maxRange, stations, usedStations) {
    const reachable = [];
    
    for (const station of stations) {
        if (usedStations.has(station.id)) continue;
        if (station.distanceFromStart <= currentPosition) continue;
        
        const distance = station.distanceFromStart - currentPosition;
        if (distance <= maxRange && distance > 0) {
            reachable.push({ ...station, distanceFromCurrent: distance });
        }
    }
    
    if (reachable.length === 0) return null;
    
    // Sort by: 1) price (cheapest), 2) distance from route (closest), 3) distance (furthest)
    reachable.sort((a, b) => {
        const priceDiff = (a.price || 4) - (b.price || 4);
        if (Math.abs(priceDiff) > 0.05) return priceDiff;
        
        // Same price - prefer closer to route
        const routeDistDiff = (a.distanceFromRoute || 0) - (b.distanceFromRoute || 0);
        if (Math.abs(routeDistDiff) > 0.5) return routeDistDiff;
        
        return b.distanceFromCurrent - a.distanceFromCurrent;  // Furthest first
    });
    
    return reachable[0];
}

// Find where the route crosses into high-price states (CA, WA)
// Returns array of border crossings with the last station before each crossing
function findStateBorderCrossings(stationsAlongRoute, highPriceStates) {
    const crossings = [];
    
    if (stationsAlongRoute.length < 2) return crossings;
    
    let previousState = stationsAlongRoute[0].state;
    
    for (let i = 1; i < stationsAlongRoute.length; i++) {
        const station = stationsAlongRoute[i];
        const currentState = station.state;
        
        // Detect when entering a high-price state from a non-high-price state
        if (highPriceStates.includes(currentState) && !highPriceStates.includes(previousState)) {
            // Find the last station before this border that's NOT in a high-price state
            let lastStationBeforeBorder = null;
            for (let j = i - 1; j >= 0; j--) {
                if (!highPriceStates.includes(stationsAlongRoute[j].state)) {
                    lastStationBeforeBorder = stationsAlongRoute[j];
                    break;
                }
            }
            
            crossings.push({
                enteringState: currentState,
                borderDistance: station.distanceFromStart,
                firstStationInState: station,
                lastStationBeforeBorder: lastStationBeforeBorder
            });
            
            console.log(`📍 Border crossing detected: Entering ${currentState} at ~${station.distanceFromStart.toFixed(0)} mi`);
            if (lastStationBeforeBorder) {
                console.log(`   Last station before border: ${lastStationBeforeBorder.name} #${lastStationBeforeBorder.stationNumber} in ${lastStationBeforeBorder.state}`);
            }
        }
        
        previousState = currentState;
    }
    
    return crossings;
}

function findStationsAlongRoute(routeData) {
    const dataset = (state.stations && state.stations.length) ? state.stations : [];
    if (!dataset.length) return [];
    
    // Max distance from route - stations must be very close to the highway
    // Typical interstate exits are 0.5-2 miles from the highway
    const routeBuffer = 3; // miles - only stations within 3 miles of the route
    const stations = [];
    
    dataset.forEach(station => {
        // Check if station is near any point on the route
        let minDistance = Infinity;
        let closestRouteIndex = 0;
        
        for (let i = 0; i < routeData.coordinates.length; i++) {
            const coord = routeData.coordinates[i];
            const dist = haversineDistance(station.lat, station.lng, coord[0], coord[1]);
            if (dist < minDistance) {
                minDistance = dist;
                closestRouteIndex = i;
            }
        }
        
        if (minDistance <= routeBuffer) {
            // Calculate distance from start along route
            const routeProgress = closestRouteIndex / (routeData.coordinates.length - 1);
            const distanceFromStart = routeProgress * routeData.distance;
            
            stations.push({
                ...station,
                distanceFromStart,
                distanceFromRoute: minDistance,
                routeIndex: closestRouteIndex
            });
        }
    });
    
    // Sort by distance from start, with secondary sort by distance from route
    // This ensures stations closest to the actual highway are preferred
    stations.sort((a, b) => {
        const distDiff = a.distanceFromStart - b.distanceFromStart;
        if (Math.abs(distDiff) < 5) {
            // If stations are within 5 miles of each other along route,
            // prefer the one closer to the actual highway
            return a.distanceFromRoute - b.distanceFromRoute;
        }
        return distDiff;
    });
    
    console.log(`Found ${stations.length} stations within ${routeBuffer} miles of route`);
    
    return stations;
}


function createStopFromStation(stopNumber, station, gallonsToAdd, fillAmount, routeData, fuelArriving) {
    // Use actual station price from database
    const price = station.price || 3.00; // Default if not set
    
    // Determine price category based on thresholds
    let priceCategory;
    if (price <= CONFIG.priceThresholds.excellent) {
        priceCategory = 'excellent';
    } else if (price <= CONFIG.priceThresholds.good) {
        priceCategory = 'good';
    } else if (price <= CONFIG.priceThresholds.fair) {
        priceCategory = 'fair';
    } else {
        priceCategory = 'high';
    }
    
    const timeToStop = (station.distanceFromStart / routeData.distance) * routeData.duration;
    const savings = Math.max(0, Math.round((CONFIG.avgNationalPrice - price) * gallonsToAdd));
    
    const exitLabel = station.exit || 'On route';
    const exitNumber = exitLabel.includes('Exit ') ? exitLabel.replace('Exit ', '') : exitLabel;
    
    return {
        number: stopNumber,
        chain: station.name,
        logo: station.name === 'Pilot' ? 'pilot' : 'flyingj',
        stationNumber: station.stationNumber || station.number,
        exitNumber,
        exit: exitLabel,
        interstate: station.interstate || exitLabel,
        city: station.city,
        state: station.state,
        postalCode: station.postalCode || '',
        address: removeCountryFromAddress(station.address || buildFallbackAddress(station)),
        price: price,
        priceCategory,
        distance: Math.round(station.distanceFromStart),
        time: timeToStop.toFixed(1),
        coords: { lat: station.lat, lng: station.lng },
        gallonsToAdd,
        fuelRemaining: typeof fuelArriving === 'number' ? parseFloat(fuelArriving.toFixed(1)) : null,
        fillAmount: Math.round(fillAmount),
        isFull: fillAmount >= 0.95 * parseInt(document.getElementById('tank-size').value),
        savings
    };
}

// REMOVED: generateSimulatedStop - We NEVER use fake station data
// All stations must come from the real CSV database

async function enrichFuelStops(stops) {
    await Promise.all(stops.map(async (stop) => {
        await enrichStopDetails(stop);
    }));
}

async function enrichStopDetails(stop) {
    // IMPORTANT: Do NOT overwrite station number, city, state, or address!
    // All station data comes directly from the CSV and is already accurate.
    // We removed the coordinate-based lookup that was causing wrong station matches.
    
    // Only clean the address format (remove country suffix)
    if (stop.address) {
        stop.address = removeCountryFromAddress(stop.address);
    }
}

// ============================================
// MAP DISPLAY
// ============================================

function displayRouteOnMap(routeData, fuelStops) {
    if (!state.resultsMap) return;
    if (!state.resultsMapReady) {
        state.pendingRoute = { routeData, fuelStops };
        return;
    }
    
    // Clear previous
    if (state.resultsRoutePolyline) {
        if (state.resultsMap.getLayer('route-line')) {
            state.resultsMap.removeLayer('route-line');
        }
        if (state.resultsMap.getSource('route')) {
            state.resultsMap.removeSource('route');
        }
        state.resultsRoutePolyline = null;
    }
    if (state.resultsMarkers && state.resultsMarkers.length) {
        state.resultsMarkers.forEach(removeMarker);
    }
    state.resultsMarkers = [];
    
    const coords = routeData.coordinates.map(coord => [coord[1], coord[0]]); // [lng, lat]
    const routeGeojson = {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: coords
        }
    };
    
    if (!state.resultsMap.getSource('route')) {
        state.resultsMap.addSource('route', {
            type: 'geojson',
            data: routeGeojson
        });
        state.resultsMap.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            paint: {
                'line-color': '#3b82f6',
                'line-width': 5,
                'line-opacity': 0.85
            }
        });
    } else {
        state.resultsMap.getSource('route').setData(routeGeojson);
    }
    state.resultsRoutePolyline = true;
    
    const bounds = new mapboxgl.LngLatBounds();
    coords.forEach(pt => bounds.extend(pt));
    
    const startMarker = createAdvancedMarker({
        map: state.resultsMap,
        position: { lat: routeData.startCoords.lat, lng: routeData.startCoords.lng },
        html: `<div class="route-marker route-marker-start">A</div>`,
        title: 'Start',
        zIndex: 2000
    });
    state.resultsMarkers.push(startMarker);
    
    const endMarker = createAdvancedMarker({
        map: state.resultsMap,
        position: { lat: routeData.endCoords.lat, lng: routeData.endCoords.lng },
        html: `<div class="route-marker route-marker-end">🎯</div>`,
        title: 'Destination',
        zIndex: 2000
    });
    state.resultsMarkers.push(endMarker);
    
    fuelStops.forEach((stop) => {
        const iconConfig = MAP_ICON_CONFIG[stop.logo === 'flyingj' ? 'flyingj' : 'pilot'];
        const stopId = `stop-${stop.stationNumber || stop.number}`;
        
        const marker = createAdvancedMarker({
            map: state.resultsMap,
            position: { lat: stop.coords.lat, lng: stop.coords.lng },
            html: `
                <div class="station-marker ${stop.logo}" data-stop-id="${stopId}">
                    <img src="${iconConfig.url}" alt="${stop.chain}">
                </div>
            `,
            title: `${stop.chain}${stop.stationNumber ? ` #${stop.stationNumber}` : ''}`,
            anchor: 'bottom'
        });
        
        // Store stop data for selection
        marker._stopData = stop;
        marker._stopId = stopId;
        
        const el = marker.getElement();
        
        // Click to select and zoom
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            selectFuelStop(stop, marker, state.resultsMap);
        });
        
        state.resultsMarkers.push(marker);
    });
    
    if (!bounds.isEmpty()) {
        state.resultsMap.fitBounds(bounds, { padding: 60 });
    }
}

// ============================================
// UI RENDERING
// ============================================

function renderFuelStopCards(fuelStops) {
    const container = document.getElementById('fuel-stops-container');
    
    if (fuelStops.length === 0) {
        container.innerHTML = `
            <div class="no-stops-message" style="text-align: center; padding: 40px 20px;">
                <h3 style="color: #22c55e; margin-bottom: 8px;">Great news!</h3>
                <p style="color: #6b6b6b;">You have enough fuel to complete this trip and arrive with 3/4 tank!</p>
            </div>
        `;
        return;
    }
    
    // Get price exceptions from admin
    const priceExceptions = getPriceExceptions();
    
    const cardsHtml = fuelStops.map((stop) => {
        // Check if there's a price exception for this station
        const exception = priceExceptions.find(e => e.storeNumber === stop.stationNumber);
        const displayPrice = exception ? exception.discountedPrice : stop.price;
        const hasDiscount = !!exception;
        
        // Recalculate savings with discounted price
        const actualSavings = hasDiscount 
            ? ((CONFIG.avgNationalPrice - displayPrice) * stop.gallonsToAdd).toFixed(2)
            : stop.savings;
        
        // Check if filling full tank - show "Full Tank" for large fills
        // Either 70%+ of tank capacity OR 100+ gallons
        const tankCapacity = state.tankSize || 200;
        const isFullTank = stop.gallonsToAdd >= (tankCapacity * 0.70) || stop.gallonsToAdd >= 100;
        
        // Create Apple Maps URL
        const appleMapsUrl = `https://maps.apple.com/?q=${encodeURIComponent(stop.chain + ' #' + stop.stationNumber)}&ll=${stop.coords.lat},${stop.coords.lng}`;
        const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.coords.lat},${stop.coords.lng}`;
        
        return `
        <div class="stop-section" data-stop-id="${stop.stationNumber}" data-stop-index="${stop.number}">
            <div class="stop-header">
                <span class="stop-label">Stop ${stop.number}/${fuelStops.length}</span>
                <span class="savings-badge">Savings ~ $${actualSavings}</span>
            </div>
            
            <div class="fuel-card" data-station-number="${stop.stationNumber}">
                <div class="card-top-row">
                    <div class="logo-and-number">
                        <img src="assets/${stop.logo === 'pilot' ? 'pilot-logoPNG.png' : 'flyingJ-logoPNG.png'}" 
                             alt="${stop.chain}" 
                             class="station-brand-logo">
                        <span class="pilot-number-label">${stop.chain} #${stop.stationNumber}</span>
                    </div>
                    <div class="interstate-badge">
                        <span class="exit-icon">↗</span>
                        ${stop.interstate || stop.exit}
                    </div>
                </div>
                
                <div class="card-stats-grid two-columns">
                    <div class="stat-item stat-large">
                        <div class="stat-label">Distance</div>
                        <div class="stat-value-large">~${stop.distance}</div>
                        <div class="stat-unit">miles</div>
                    </div>
                    
                    <div class="stat-item stat-large">
                        <div class="stat-label">Fill</div>
                        ${isFullTank ? `
                            <div class="fill-value-row">
                                <span class="fill-icon">⛽</span>
                                <span class="fill-amount-large">Full Tank</span>
                            </div>
                        ` : `
                            <div class="fill-value-row">
                                <span class="fill-icon">⛽</span>
                                <span class="fill-amount-large">${stop.gallonsToAdd}</span>
                            </div>
                            <div class="stat-unit">gallons</div>
                        `}
                    </div>
                </div>
                
                <div class="maps-buttons-row">
                    <a href="${appleMapsUrl}" 
                       target="_blank" 
                       class="open-maps-btn apple-maps">
                        <span class="maps-icon">🍎</span>
                        Apple Maps
                    </a>
                    <a href="${googleMapsUrl}" 
                       target="_blank" 
                       class="open-maps-btn google-maps">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
                            <circle cx="12" cy="10" r="3"/>
                        </svg>
                        Google Maps
                    </a>
                </div>
            </div>
        </div>
    `}).join('');
    
    let summaryHtml = '';
    if (state.tripSummary) {
        summaryHtml = `
            <div class="trip-summary-card">
                <h3>Trip Summary</h3>
                <div class="trip-summary-row">
                    <span>Fuel left at destination</span>
                    <strong>${state.tripSummary.finalFuel.toFixed(1)} gal</strong>
                </div>
                <div class="trip-summary-row">
                    <span>Total savings</span>
                    <strong>$${state.tripSummary.totalSavings.toFixed(2)}</strong>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = cardsHtml + summaryHtml;
    
    // Add event listeners for copy address buttons
    container.querySelectorAll('.copy-address-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const address = btn.getAttribute('data-address');
            try {
                await navigator.clipboard.writeText(address);
                // Visual feedback
                const originalHTML = btn.innerHTML;
                btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                btn.style.color = '#22c55e';
                setTimeout(() => {
                    btn.innerHTML = originalHTML;
                    btn.style.color = '';
                }, 2000);
            } catch (err) {
                console.error('Failed to copy address:', err);
                showError('Failed to copy address');
            }
        });
    });
}

function formatTime(hours) {
    if (hours < 1) {
        return `${Math.round(hours * 60)} min`;
    }
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (m === 0) {
        return `${h} hour${h > 1 ? 's' : ''}`;
    }
    return `${h}h ${m}m`;
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================
// VIEW SWITCHING
// ============================================

function showResultsView() {
    document.getElementById('input-view').classList.remove('active');
    document.getElementById('results-view').classList.add('active');
}

function showInputView() {
    document.getElementById('results-view').classList.remove('active');
    document.getElementById('input-view').classList.add('active');
}

function handleBack() {
    showInputView();
    
    if (state.resultsRoutePolyline) {
        state.resultsRoutePolyline = null;
        if (state.resultsMap && state.resultsMap.getLayer('route-line')) {
            state.resultsMap.removeLayer('route-line');
        }
        if (state.resultsMap && state.resultsMap.getSource('route')) {
            state.resultsMap.removeSource('route');
        }
    }
    if (state.resultsMarkers && state.resultsMarkers.length) {
        state.resultsMarkers.forEach(removeMarker);
    }
    state.resultsMarkers = [];
    if (state.resultsInfoWindow) {
        state.resultsInfoWindow.close();
    }
    state.tripSummary = null;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function showLoading(message = DEFAULT_LOADING_TEXT) {
    const overlay = document.getElementById('loading-overlay');
    const messageNode = overlay.querySelector('p');
    if (messageNode) {
        messageNode.textContent = message;
    }
    overlay.classList.remove('hidden');
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    const messageNode = overlay.querySelector('p');
    if (messageNode) {
        messageNode.textContent = DEFAULT_LOADING_TEXT;
    }
    overlay.classList.add('hidden');
}

function showError(message) {
    const toast = document.getElementById('error-toast');
    const messageEl = document.getElementById('error-message');
    
    messageEl.textContent = message;
    toast.classList.remove('hidden');
    
    setTimeout(() => {
        toast.classList.add('hidden');
    }, 4000);
}

async function fetchFormattedAddress(lat, lng) {
    // Prefer Mapbox geocoding
    try {
        const response = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${MAPBOX_TOKEN}&types=address&limit=1`);
        const data = await response.json();
        if (data.features && data.features.length) {
            const feature = data.features[0];
            const postal = feature.context?.find(c => c.id.startsWith('postcode'))?.text;
            return {
                address: removeCountryFromAddress(feature.place_name),
                postalCode: postal || null
            };
        }
    } catch (error) {
        console.warn('Mapbox geocoding failed', error);
    }
    return null;
}

async function reverseGeocodeZip(lat, lng) {
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
            { headers: { 'User-Agent': 'FuelPlannerApp/1.0' } }
        );
        const data = await response.json();
        if (data?.address?.postcode) {
            return { zip: data.address.postcode, address: data.display_name };
        }
    } catch (error) {
        console.warn('Nominatim reverse geocode failed', error);
    }
    
    const googleAddress = await fetchFormattedAddress(lat, lng);
    if (googleAddress?.postalCode) {
        return { zip: googleAddress.postalCode, address: googleAddress.address };
    }
    return null;
}

// ============================================
// DEMO MODE
// ============================================

window.demoMode = function(mode = 'long') {
    if (mode === 'long') {
        // Long cross-country trip: San Francisco to New York
        state.startZip = '94102';
        document.getElementById('start-zip').value = '94102';
        document.getElementById('start-zip-text').textContent = '94102';
        document.getElementById('start-zip-btn').classList.add('has-value');
        
        state.endZip = '10001';
        document.getElementById('end-zip').value = '10001';
        document.getElementById('end-zip-text').textContent = '10001';
        document.getElementById('end-zip-btn').classList.add('has-value');
        
        // Low starting fuel to test multiple stops
        document.getElementById('tank-size').value = '150';
        document.getElementById('tank-value').textContent = '150';
        document.getElementById('current-gallons').value = '30';
        document.getElementById('gallons-value').textContent = '30';
        document.getElementById('mpg').value = '7.0';
        document.getElementById('mpg-value').textContent = '7.0';
        
        console.log('Demo: San Francisco to New York (~2,900 miles)');
        console.log('Tank: 150 gal, Current: 30 gal, MPG: 7.0');
        console.log('Max range: 1,050 miles, Starting range: 210 miles');
        console.log('Will need multiple fuel stops!');
        
    } else if (mode === 'wa') {
        // Trip to Washington (tests full tank rule)
        state.startZip = '94102';
        document.getElementById('start-zip').value = '94102';
        document.getElementById('start-zip-text').textContent = '94102';
        document.getElementById('start-zip-btn').classList.add('has-value');
        
        state.endZip = '98101';
        document.getElementById('end-zip').value = '98101';
        document.getElementById('end-zip-text').textContent = '98101';
        document.getElementById('end-zip-btn').classList.add('has-value');
        
        document.getElementById('tank-size').value = '200';
        document.getElementById('tank-value').textContent = '200';
        document.getElementById('current-gallons').value = '50';
        document.getElementById('gallons-value').textContent = '50';
        document.getElementById('mpg').value = '8.0';
        document.getElementById('mpg-value').textContent = '8.0';
        
        console.log('Demo: San Francisco to Seattle (~800 miles)');
        console.log('WA destination requires full tank before entering!');
        
    } else {
        // Short trip
        state.startZip = '94102';
        document.getElementById('start-zip').value = '94102';
        document.getElementById('start-zip-text').textContent = '94102';
        document.getElementById('start-zip-btn').classList.add('has-value');
        
        state.endZip = '95814';
        document.getElementById('end-zip').value = '95814';
        document.getElementById('end-zip-text').textContent = '95814';
        document.getElementById('end-zip-btn').classList.add('has-value');
        
        document.getElementById('tank-size').value = '150';
        document.getElementById('tank-value').textContent = '150';
        document.getElementById('current-gallons').value = '100';
        document.getElementById('gallons-value').textContent = '100';
        document.getElementById('mpg').value = '8.0';
        document.getElementById('mpg-value').textContent = '8.0';
        
        console.log('Demo: San Francisco to Sacramento (~90 miles)');
        console.log('Short trip, may not need fuel stops.');
    }
    
    console.log('Click Calculate to see the fuel stops!');
};

// Shortcut demos
window.longTrip = () => demoMode('long');
window.waTrip = () => demoMode('wa');
window.shortTrip = () => demoMode('short');
