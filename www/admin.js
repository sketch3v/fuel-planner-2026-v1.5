/**
 * ============================================
 * FUEL PLANNER - ADMIN DASHBOARD
 * Manage Price Exceptions for Stations
 * ============================================
 */

// ============================================
// STATE
// ============================================
let stations = [];
let selectedStation = null;
let priceExceptions = [];
let deleteTarget = null;

const EXCEPTIONS_STORAGE_KEY = 'fuelPlannerPriceExceptions';

// ============================================
// INITIALIZE ADMIN PAGE
// ============================================
async function initAdmin() {
    // Check authentication
    const user = window.FuelPlannerAuth.checkAuthState();
    
    if (!user) {
        return; // Will redirect to login
    }
    
    // Check if admin
    if (!window.FuelPlannerAuth.isAdmin()) {
        window.FuelPlannerAuth.showToast('Access denied. Admin only.', 'error');
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 1500);
        return;
    }
    
    console.log('✅ Admin access granted');
    
    // Load data
    await loadStations();
    loadExceptions();
    
    // Setup event listeners
    setupEventListeners();
}

// ============================================
// LOAD STATIONS FROM CSV
// ============================================
async function loadStations() {
    try {
        const response = await fetch('assets/all_locations.csv?v=' + Date.now());
        const text = await response.text();
        stations = parseStationsCSV(text);
        console.log(`✅ Loaded ${stations.length} stations`);
    } catch (error) {
        console.error('Failed to load stations:', error);
        window.FuelPlannerAuth.showToast('Failed to load stations', 'error');
    }
}

// ============================================
// PARSE CSV
// ============================================
function parseStationsCSV(text) {
    const lines = parseCSVWithMultiline(text);
    if (lines.length < 2) return [];
    
    const headers = lines[0].map(h => h.trim().toLowerCase());
    const storeIdx = headers.findIndex(h => h.includes('store'));
    const nameIdx = headers.findIndex(h => h === 'name');
    const addressIdx = headers.findIndex(h => h === 'address');
    const latIdx = headers.findIndex(h => h.includes('lat'));
    const lngIdx = headers.findIndex(h => h.includes('long'));
    const interstateIdx = headers.findIndex(h => h.includes('interstate'));
    
    const result = [];
    
    for (let i = 1; i < lines.length; i++) {
        const row = lines[i];
        if (!row || row.length < 3) continue;
        
        const storeNum = row[storeIdx]?.replace(/\D/g, '') || '';
        const name = row[nameIdx]?.trim() || '';
        const address = row[addressIdx]?.trim() || '';
        const lat = parseFloat(row[latIdx]) || 0;
        const lng = parseFloat(row[lngIdx]) || 0;
        const interstate = row[interstateIdx]?.trim() || '';
        
        if (storeNum && name) {
            result.push({
                id: `station-${storeNum}`,
                storeNumber: storeNum,
                name: name,
                address: address,
                lat: lat,
                lng: lng,
                interstate: interstate,
                brand: name.toLowerCase().includes('flying') ? 'flyingj' : 'pilot'
            });
        }
    }
    
    return result;
}

// ============================================
// PARSE CSV WITH MULTILINE SUPPORT
// ============================================
function parseCSVWithMultiline(text) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let insideQuotes = false;
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];
        
        if (insideQuotes) {
            if (char === '"') {
                if (nextChar === '"') {
                    currentField += '"';
                    i++;
                } else {
                    insideQuotes = false;
                }
            } else {
                currentField += char;
            }
        } else {
            if (char === '"') {
                insideQuotes = true;
            } else if (char === ',') {
                currentRow.push(currentField);
                currentField = '';
            } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
                currentRow.push(currentField);
                if (currentRow.length > 1 || currentRow[0] !== '') {
                    rows.push(currentRow);
                }
                currentRow = [];
                currentField = '';
                if (char === '\r') i++;
            } else if (char !== '\r') {
                currentField += char;
            }
        }
    }
    
    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
    }
    
    return rows;
}

// ============================================
// LOAD EXCEPTIONS FROM STORAGE
// ============================================
function loadExceptions() {
    const saved = localStorage.getItem(EXCEPTIONS_STORAGE_KEY);
    priceExceptions = saved ? JSON.parse(saved) : [];
    renderExceptionList();
    updateStats();
}

// ============================================
// SAVE EXCEPTIONS TO STORAGE
// ============================================
function saveExceptions() {
    localStorage.setItem(EXCEPTIONS_STORAGE_KEY, JSON.stringify(priceExceptions));
}

// ============================================
// SEARCH STATIONS
// ============================================
function searchStations(query) {
    if (!query || query.length < 2) return [];
    
    const q = query.toLowerCase();
    
    return stations.filter(station => {
        return station.storeNumber.includes(q) ||
               station.name.toLowerCase().includes(q) ||
               station.address.toLowerCase().includes(q);
    }).slice(0, 10);
}

// ============================================
// RENDER SEARCH RESULTS
// ============================================
function renderSearchResults(results) {
    const container = document.getElementById('station-search-results');
    
    if (results.length === 0) {
        container.classList.remove('active');
        return;
    }
    
    container.innerHTML = results.map(station => `
        <div class="station-result-item" data-station-id="${station.id}">
            <div class="station-result-name">#${station.storeNumber} - ${station.name}</div>
            <div class="station-result-address">${station.address}</div>
        </div>
    `).join('');
    
    container.classList.add('active');
    
    // Add click handlers
    container.querySelectorAll('.station-result-item').forEach(item => {
        item.addEventListener('click', () => {
            const stationId = item.dataset.stationId;
            const station = stations.find(s => s.id === stationId);
            if (station) selectStation(station);
        });
    });
}

// ============================================
// SELECT STATION
// ============================================
function selectStation(station) {
    selectedStation = station;
    
    // Update UI
    document.getElementById('station-search').value = `#${station.storeNumber} - ${station.name}`;
    document.getElementById('station-search-results').classList.remove('active');
    
    document.getElementById('selected-station-name').textContent = `#${station.storeNumber} - ${station.name}`;
    document.getElementById('selected-station-address').textContent = station.address;
    document.getElementById('selected-station-info').classList.remove('hidden');
    
    validateForm();
}

// ============================================
// VALIDATE FORM
// ============================================
function validateForm() {
    const originalPrice = parseFloat(document.getElementById('original-price').value) || 0;
    const discountedPrice = parseFloat(document.getElementById('discounted-price').value) || 0;
    const addBtn = document.getElementById('add-exception-btn');
    const savingsPreview = document.getElementById('savings-preview');
    const savingsAmount = document.getElementById('savings-amount');
    
    const isValid = selectedStation && 
                    originalPrice > 0 && 
                    discountedPrice > 0 && 
                    discountedPrice < originalPrice;
    
    addBtn.disabled = !isValid;
    
    if (originalPrice > 0 && discountedPrice > 0) {
        const savings = originalPrice - discountedPrice;
        savingsAmount.textContent = `$${savings.toFixed(3)}`;
        savingsPreview.classList.remove('hidden');
        
        if (discountedPrice >= originalPrice) {
            savingsAmount.style.color = '#dc2626';
            savingsAmount.textContent = 'Invalid (must be lower)';
        } else {
            savingsAmount.style.color = '#22c55e';
        }
    } else {
        savingsPreview.classList.add('hidden');
    }
}

// ============================================
// ADD EXCEPTION
// ============================================
function addException() {
    if (!selectedStation) return;
    
    const originalPrice = parseFloat(document.getElementById('original-price').value);
    const discountedPrice = parseFloat(document.getElementById('discounted-price').value);
    
    // Check if exception already exists for this station
    const existingIndex = priceExceptions.findIndex(e => e.stationId === selectedStation.id);
    
    const exception = {
        id: Date.now().toString(),
        stationId: selectedStation.id,
        storeNumber: selectedStation.storeNumber,
        stationName: selectedStation.name,
        address: selectedStation.address,
        originalPrice: originalPrice,
        discountedPrice: discountedPrice,
        discount: originalPrice - discountedPrice,
        createdAt: new Date().toISOString(),
        createdBy: window.FuelPlannerAuth.getCurrentUser()?.phone || 'admin'
    };
    
    if (existingIndex !== -1) {
        // Update existing
        priceExceptions[existingIndex] = exception;
        window.FuelPlannerAuth.showToast('Price exception updated!', 'success');
    } else {
        // Add new
        priceExceptions.push(exception);
        window.FuelPlannerAuth.showToast('Price exception added!', 'success');
    }
    
    saveExceptions();
    renderExceptionList();
    updateStats();
    resetForm();
}

// ============================================
// DELETE EXCEPTION
// ============================================
function showDeleteModal(exceptionId) {
    const exception = priceExceptions.find(e => e.id === exceptionId);
    if (!exception) return;
    
    deleteTarget = exceptionId;
    document.getElementById('delete-station-name').textContent = 
        `#${exception.storeNumber} - ${exception.stationName}`;
    document.getElementById('delete-modal').classList.remove('hidden');
}

function confirmDelete() {
    if (!deleteTarget) return;
    
    priceExceptions = priceExceptions.filter(e => e.id !== deleteTarget);
    saveExceptions();
    renderExceptionList();
    updateStats();
    
    document.getElementById('delete-modal').classList.add('hidden');
    deleteTarget = null;
    
    window.FuelPlannerAuth.showToast('Exception deleted', 'success');
}

function cancelDelete() {
    document.getElementById('delete-modal').classList.add('hidden');
    deleteTarget = null;
}

// ============================================
// RENDER EXCEPTION LIST
// ============================================
function renderExceptionList() {
    const container = document.getElementById('exception-list');
    const emptyState = document.getElementById('empty-state');
    
    if (priceExceptions.length === 0) {
        emptyState.style.display = 'block';
        return;
    }
    
    emptyState.style.display = 'none';
    
    // Sort by most recent first
    const sorted = [...priceExceptions].sort((a, b) => 
        new Date(b.createdAt) - new Date(a.createdAt)
    );
    
    container.innerHTML = sorted.map(exception => `
        <div class="exception-card" data-exception-id="${exception.id}">
            <div class="exception-info">
                <div class="exception-station">#${exception.storeNumber} - ${exception.stationName}</div>
                <div class="exception-details">
                    <span class="exception-original">$${exception.originalPrice.toFixed(3)}</span>
                    <span class="exception-arrow">→</span>
                    <span class="exception-discounted">$${exception.discountedPrice.toFixed(3)}</span>
                    <span class="exception-savings">-$${exception.discount.toFixed(3)}</span>
                </div>
            </div>
            <button class="delete-exception-btn" data-exception-id="${exception.id}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/>
                </svg>
            </button>
        </div>
    `).join('') + '<div class="empty-state" id="empty-state" style="display:none;"><div class="empty-state-icon">📭</div><div class="empty-state-title">No exceptions yet</div><div class="empty-state-text">Add a price exception above to get started.</div></div>';
    
    // Add delete handlers
    container.querySelectorAll('.delete-exception-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showDeleteModal(btn.dataset.exceptionId);
        });
    });
}

// ============================================
// UPDATE STATS
// ============================================
function updateStats() {
    document.getElementById('total-exceptions').textContent = priceExceptions.length;
    
    if (priceExceptions.length > 0) {
        const avgDiscount = priceExceptions.reduce((sum, e) => sum + e.discount, 0) / priceExceptions.length;
        document.getElementById('avg-savings').textContent = `$${avgDiscount.toFixed(3)}`;
    } else {
        document.getElementById('avg-savings').textContent = '$0.00';
    }
}

// ============================================
// RESET FORM
// ============================================
function resetForm() {
    selectedStation = null;
    document.getElementById('station-search').value = '';
    document.getElementById('original-price').value = '';
    document.getElementById('discounted-price').value = '';
    document.getElementById('selected-station-info').classList.add('hidden');
    document.getElementById('savings-preview').classList.add('hidden');
    document.getElementById('add-exception-btn').disabled = true;
}

// ============================================
// SETUP EVENT LISTENERS
// ============================================
function setupEventListeners() {
    // Back button
    document.getElementById('back-to-app').addEventListener('click', () => {
        window.location.href = 'index.html';
    });
    
    // Station search
    const searchInput = document.getElementById('station-search');
    let searchTimeout;
    
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        selectedStation = null;
        document.getElementById('selected-station-info').classList.add('hidden');
        
        searchTimeout = setTimeout(() => {
            const results = searchStations(e.target.value);
            renderSearchResults(results);
        }, 200);
    });
    
    searchInput.addEventListener('focus', (e) => {
        if (e.target.value.length >= 2) {
            const results = searchStations(e.target.value);
            renderSearchResults(results);
        }
    });
    
    // Close search results when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.station-search-wrapper')) {
            document.getElementById('station-search-results').classList.remove('active');
        }
    });
    
    // Price inputs
    document.getElementById('original-price').addEventListener('input', validateForm);
    document.getElementById('discounted-price').addEventListener('input', validateForm);
    
    // Add exception button
    document.getElementById('add-exception-btn').addEventListener('click', addException);
    
    // Delete modal
    document.getElementById('cancel-delete').addEventListener('click', cancelDelete);
    document.getElementById('confirm-delete').addEventListener('click', confirmDelete);
    
    // Close modal on overlay click
    document.getElementById('delete-modal').addEventListener('click', (e) => {
        if (e.target.id === 'delete-modal') {
            cancelDelete();
        }
    });
}

// ============================================
// ADD STYLES FOR SELECTED STATION
// ============================================
const additionalStyles = `
.selected-station-info {
    margin-bottom: 16px;
}

.selected-station-card {
    background: #dcfce7;
    border: 2px solid #22c55e;
    border-radius: 12px;
    padding: 14px 16px;
}

.selected-station-name {
    font-weight: 600;
    color: #166534;
    font-size: 15px;
    margin-bottom: 4px;
}

.selected-station-address {
    font-size: 13px;
    color: #15803d;
}

.savings-preview {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #f0fdf4;
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
}

.savings-label {
    font-size: 14px;
    color: #6b6b6b;
}

.savings-amount {
    font-size: 18px;
    font-weight: 700;
    color: #22c55e;
}
`;

// Inject additional styles
const styleSheet = document.createElement('style');
styleSheet.textContent = additionalStyles;
document.head.appendChild(styleSheet);

// ============================================
// EXPORT FOR MAIN APP
// ============================================
window.FuelPlannerAdmin = {
    getPriceExceptions: () => {
        const saved = localStorage.getItem(EXCEPTIONS_STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
    },
    
    getExceptionForStation: (storeNumber) => {
        const saved = localStorage.getItem(EXCEPTIONS_STORAGE_KEY);
        const exceptions = saved ? JSON.parse(saved) : [];
        return exceptions.find(e => e.storeNumber === storeNumber);
    }
};

// ============================================
// INITIALIZE
// ============================================
document.addEventListener('DOMContentLoaded', initAdmin);






