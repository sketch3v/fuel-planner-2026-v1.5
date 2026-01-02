# iOS Configuration Instructions

After running `npx cap sync ios`, you need to add these settings to your iOS project.

## Step 1: Open Info.plist in Xcode

1. Open the project: `npx cap open ios`
2. In Xcode sidebar, expand **App** → **App**
3. Click on **Info.plist** (or Info tab in project settings)

## Step 2: Add These Keys

Right-click and select "Add Row" for each:

### Allow Network Connections (Required for Mapbox & Firebase)

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
</dict>
```

### Location Permission (for GPS tracking)

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Fuel Planner needs your location to show nearby fuel stations and calculate routes.</string>

<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Fuel Planner needs your location to show nearby fuel stations and calculate routes.</string>
```

## Step 3: In Xcode GUI (Easier Method)

1. Select the **App** target
2. Go to **Info** tab
3. Under **Custom iOS Target Properties**, add:
   - `App Transport Security Settings` → `Allow Arbitrary Loads` = YES
   - `Privacy - Location When In Use Usage Description` = "Fuel Planner needs your location..."

## Step 4: Build and Run

Press **Cmd + R** to build and run on your iPhone!

---

## Quick Reference: Terminal Commands

```bash
# On Mac - Navigate to project
cd ~/Desktop/fuel-planner-2026-v1.5/"Fuel App"

# Build (copies files to www)
npm run build

# Sync with iOS
npx cap sync ios

# Open in Xcode
npx cap open ios
```

## Troubleshooting

- **Map not loading**: Make sure NSAppTransportSecurity is set
- **Firebase not working**: Check that allowNavigation in capacitor.config.json includes firebase URLs
- **Location not working**: Add location permission strings to Info.plist

