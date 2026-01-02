# Fuel Planner

A web application that helps truck drivers plan fuel stops along their route using **Pilot** and **Flying J** stations exclusively. Optimizes costs, considers tank size, and recommends gallons to fill at each station.

/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

## Features

### Main Screen
- **Interactive Map** displaying all Pilot and Flying J stations with branded markers
- **ZIP Code Selection** with two options:
  - Enter manually
  - Use My Location (GPS)
- **Vehicle Parameters** with iOS-style wheel pickers:
  - **Tank Size**: 100-300 gallons (step: 10)
  - **Gallons Now**: 0-300 gallons (step: 1)  
  - **MPG**: 5.0-20.0 (step: 0.1)
- **Calculate** button to plan the route

### Results Screen
- Full route displayed on map with:
  - Start (A) and End (B) markers
  - Numbered fuel stop markers with Pilot/Flying J branding
- Fuel stop cards showing:
  - Station name and number
  - Exit information
  - Price per gallon with rating (Excellent/Good/Fair/High)
  - Distance and time from start
  - Gallons to fill

## Smart Fuel Planning

### Route Coverage
- Calculates **ALL fuel stops needed** for the entire route (not limited to 2-3)
- Uses real Pilot and Flying J station locations across the US

### Destination Rules
- **3/4 Tank at Arrival**: Algorithm ensures you arrive at your destination with at least 75% fuel remaining
- **California & Washington Rule**: If your destination is in CA or WA, the app will plan a full tank fill-up at the last station before entering these states

## Quick Start

1. Open `index.html` in your web browser
2. Click **Start ZIP** and choose:
   - "Enter manually" to type a ZIP code
   - "My Location" to use GPS
3. Click **End ZIP** and set your destination
4. Tap the colored boxes to adjust:
   - Tank size (orange)
   - Current gallons (green)
   - MPG (blue)
5. Click **Calculate** to see your fuel stops

## Demo Mode

Open the browser console and use these commands:

- `demoMode('long')` or `longTrip()` - San Francisco to New York (~2,900 miles, tests multiple stops)
- `demoMode('wa')` or `waTrip()` - San Francisco to Seattle (tests WA full-tank rule)
- `demoMode('short')` or `shortTrip()` - San Francisco to Sacramento (short trip)

## Technical Details

### Built With
- Pure HTML5, CSS3, and JavaScript (no build tools)
- [Leaflet.js](https://leafletjs.com/) - Interactive maps
- [OpenStreetMap](https://www.openstreetmap.org/) - Map tiles
- [Nominatim](https://nominatim.org/) - Geocoding
- [OSRM](http://project-osrm.org/) - Route calculation

### Files
```
├── index.html    # Main HTML structure
├── styles.css    # CSS styles
├── app.js        # Application logic
├── stations.js   # Pilot & Flying J station database
└── README.md     # Documentation
```

### Station Database
Includes 164 real Pilot and Flying J locations across:
- All 48 contiguous US states
- Major interstate routes and highways

## Browser Support
- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## License
MIT License
