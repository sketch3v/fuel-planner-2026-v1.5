/**
 * ============================================
 * FUEL PLANNER - AUTHENTICATION SYSTEM
 * Firebase Phone Auth with Role-Based Access
 * ============================================
 */

// ============================================
// FIREBASE CONFIGURATION
// ============================================
// TODO: Replace with your actual Firebase config
const firebaseConfig = {
    apiKey: "AIzaSyDofN-dNA6QXKji0aHs5qOMoNru2Lgwb3k",
    authDomain: "fuelplannerauth.firebaseapp.com",
    projectId: "fuelplannerauth",
    storageBucket: "fuelplannerauth.firebasestorage.app",
    messagingSenderId: "214548680044",
    appId: "1:214548680044:web:299f6cef9401a822d93749",
    measurementId: "G-ZCCXRZ8HVP"
};

// ============================================
// AUTHORIZED USERS WHITELIST
// Stored locally for now - move to Firestore for production
// ============================================
const AUTHORIZED_USERS = {
    '+13475919042': {
        role: 'admin',
        name: 'Administrator',
        company: 'Fuel Planner Admin'
    },
    '+13475918305': {
        role: 'user',
        name: 'Driver',
        company: 'Trucking Company'
    }
};

// ============================================
// AUTH STATE
// ============================================
let auth = null;
let db = null;
let confirmationResult = null;
let resendTimer = null;

// ============================================
// INITIALIZE FIREBASE
// ============================================
function initializeFirebase() {
    try {
        // Check if Firebase is already initialized
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        auth = firebase.auth();
        db = firebase.firestore();
        
        // Set persistence to LOCAL (survives browser restarts)
        auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        
        console.log('✅ Firebase initialized');
        return true;
    } catch (error) {
        console.error('❌ Firebase initialization error:', error);
        return false;
    }
}

// ============================================
// CHECK AUTH STATE ON PAGE LOAD
// ============================================
function checkAuthState() {
    // Check if we're on the login page
    const isLoginPage = window.location.pathname.includes('login.html') || 
                        window.location.pathname === '/' && document.getElementById('phone-step');
    
    // Check localStorage for existing session
    const savedUser = localStorage.getItem('fuelPlannerUser');
    
    if (savedUser) {
        const userData = JSON.parse(savedUser);
        
        if (isLoginPage) {
            // Already logged in, redirect to main app
            window.location.href = 'index.html';
            return;
        }
        
        // User is authenticated
        console.log('✅ User authenticated:', userData.phone);
        return userData;
    } else {
        if (!isLoginPage) {
            // Not logged in, redirect to login
            window.location.href = 'login.html';
            return null;
        }
    }
    
    return null;
}

// ============================================
// PHONE NUMBER FORMATTING
// ============================================
function formatPhoneNumber(value) {
    // Remove all non-digits
    const digits = value.replace(/\D/g, '');
    
    // Format as (XXX) XXX-XXXX
    if (digits.length <= 3) {
        return digits;
    } else if (digits.length <= 6) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    } else {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
    }
}

function toE164(phone) {
    // Convert to E.164 format: +1XXXXXXXXXX
    const digits = phone.replace(/\D/g, '');
    return '+1' + digits;
}

// ============================================
// VALIDATE PHONE NUMBER
// ============================================
function isValidPhoneNumber(phone) {
    const digits = phone.replace(/\D/g, '');
    return digits.length === 10;
}

// ============================================
// SEND VERIFICATION CODE
// ============================================
async function sendVerificationCode() {
    const phoneInput = document.getElementById('phone-input');
    const sendBtn = document.getElementById('send-code-btn');
    const btnText = sendBtn.querySelector('.btn-text');
    const btnLoader = sendBtn.querySelector('.btn-loader');
    
    const phone = toE164(phoneInput.value);
    
    // First check if phone is in whitelist
    if (!AUTHORIZED_USERS[phone]) {
        showError('Access Denied. This phone number is not authorized.');
        return;
    }
    
    // Show loading state
    sendBtn.disabled = true;
    btnText.textContent = 'Sending...';
    btnLoader.classList.remove('hidden');
    hideError();
    
    try {
        // For development/testing without Firebase
        if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
            // Simulate sending code
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Store for mock verification
            window.mockVerificationPhone = phone;
            
            // Show code step
            showCodeStep(phone);
            return;
        }
        
        // Initialize reCAPTCHA
        if (!window.recaptchaVerifier) {
            window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
                size: 'invisible',
                callback: () => {
                    console.log('reCAPTCHA solved');
                }
            });
        }
        
        // Send verification code
        confirmationResult = await auth.signInWithPhoneNumber(phone, window.recaptchaVerifier);
        
        // Show code step
        showCodeStep(phone);
        
    } catch (error) {
        console.error('Send code error:', error);
        showError(getErrorMessage(error));
        
        // Reset reCAPTCHA on error
        if (window.recaptchaVerifier) {
            window.recaptchaVerifier.clear();
            window.recaptchaVerifier = null;
        }
    } finally {
        sendBtn.disabled = false;
        btnText.textContent = 'Send Verification Code';
        btnLoader.classList.add('hidden');
    }
}

// ============================================
// SHOW CODE STEP
// ============================================
function showCodeStep(phone) {
    document.getElementById('phone-step').classList.remove('active');
    document.getElementById('code-step').classList.add('active');
    document.getElementById('phone-display').textContent = phone;
    
    // Focus first code input
    document.querySelector('.code-digit[data-index="0"]').focus();
    
    // Start resend timer
    startResendTimer();
}

// ============================================
// VERIFY CODE
// ============================================
async function verifyCode() {
    const codeDigits = document.querySelectorAll('.code-digit');
    const code = Array.from(codeDigits).map(input => input.value).join('');
    const verifyBtn = document.getElementById('verify-code-btn');
    const btnText = verifyBtn.querySelector('.btn-text');
    const btnLoader = verifyBtn.querySelector('.btn-loader');
    
    if (code.length !== 6) {
        showError('Please enter the complete 6-digit code.');
        return;
    }
    
    // Show loading state
    verifyBtn.disabled = true;
    btnText.textContent = 'Verifying...';
    btnLoader.classList.remove('hidden');
    hideError();
    
    try {
        let phone;
        
        // For development/testing without Firebase
        if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
            // Mock verification - accept any 6-digit code
            await new Promise(resolve => setTimeout(resolve, 1000));
            phone = window.mockVerificationPhone;
        } else {
            // Real Firebase verification
            const result = await confirmationResult.confirm(code);
            phone = result.user.phoneNumber;
        }
        
        // Check whitelist for role
        const userData = AUTHORIZED_USERS[phone];
        
        if (!userData) {
            showError('Access Denied. Your phone number is not authorized.');
            
            // Sign out if using Firebase
            if (auth) {
                await auth.signOut();
            }
            return;
        }
        
        // Save user session
        const userSession = {
            phone: phone,
            role: userData.role,
            name: userData.name,
            company: userData.company,
            loginTime: new Date().toISOString()
        };
        
        localStorage.setItem('fuelPlannerUser', JSON.stringify(userSession));
        
        console.log('✅ Login successful:', userSession);
        
        // Redirect to main app
        window.location.href = 'index.html';
        
    } catch (error) {
        console.error('Verify code error:', error);
        
        // Mark code inputs as error
        codeDigits.forEach(input => {
            input.classList.add('error');
            input.classList.remove('filled');
        });
        
        showError('Invalid verification code. Please try again.');
        
        // Clear and focus first input
        codeDigits.forEach(input => input.value = '');
        codeDigits[0].focus();
    } finally {
        verifyBtn.disabled = true; // Keep disabled until code is re-entered
        btnText.textContent = 'Verify & Sign In';
        btnLoader.classList.add('hidden');
    }
}

// ============================================
// RESEND CODE
// ============================================
function startResendTimer() {
    let seconds = 60;
    const timerEl = document.getElementById('resend-timer');
    const countEl = document.getElementById('timer-count');
    const resendBtn = document.getElementById('resend-code-btn');
    
    timerEl.classList.remove('hidden');
    resendBtn.classList.add('hidden');
    
    if (resendTimer) clearInterval(resendTimer);
    
    resendTimer = setInterval(() => {
        seconds--;
        countEl.textContent = seconds;
        
        if (seconds <= 0) {
            clearInterval(resendTimer);
            timerEl.classList.add('hidden');
            resendBtn.classList.remove('hidden');
        }
    }, 1000);
}

async function resendCode() {
    const phone = document.getElementById('phone-display').textContent;
    
    // Reset code inputs
    document.querySelectorAll('.code-digit').forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
    
    hideError();
    
    // For development mode
    if (firebaseConfig.apiKey === 'YOUR_API_KEY') {
        window.mockVerificationPhone = phone;
        startResendTimer();
        document.querySelector('.code-digit[data-index="0"]').focus();
        return;
    }
    
    try {
        // Reset reCAPTCHA
        if (window.recaptchaVerifier) {
            window.recaptchaVerifier.clear();
        }
        
        window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
            size: 'invisible'
        });
        
        confirmationResult = await auth.signInWithPhoneNumber(phone, window.recaptchaVerifier);
        startResendTimer();
        document.querySelector('.code-digit[data-index="0"]').focus();
        
    } catch (error) {
        console.error('Resend error:', error);
        showError(getErrorMessage(error));
    }
}

// ============================================
// BACK TO PHONE STEP
// ============================================
function backToPhoneStep() {
    document.getElementById('code-step').classList.remove('active');
    document.getElementById('phone-step').classList.add('active');
    
    // Clear code inputs
    document.querySelectorAll('.code-digit').forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
    
    // Clear timer
    if (resendTimer) {
        clearInterval(resendTimer);
    }
    
    hideError();
    
    // Focus phone input
    document.getElementById('phone-input').focus();
}

// ============================================
// LOGOUT
// ============================================
async function logout() {
    try {
        // Clear local storage
        localStorage.removeItem('fuelPlannerUser');
        
        // Sign out from Firebase if initialized
        if (auth) {
            await auth.signOut();
        }
        
        console.log('✅ Logged out');
        
        // Redirect to login
        window.location.href = 'login.html';
        
    } catch (error) {
        console.error('Logout error:', error);
        // Force redirect anyway
        localStorage.removeItem('fuelPlannerUser');
        window.location.href = 'login.html';
    }
}

// ============================================
// GET CURRENT USER
// ============================================
function getCurrentUser() {
    const savedUser = localStorage.getItem('fuelPlannerUser');
    return savedUser ? JSON.parse(savedUser) : null;
}

// ============================================
// CHECK IF ADMIN
// ============================================
function isAdmin() {
    const user = getCurrentUser();
    return user && user.role === 'admin';
}

// ============================================
// ERROR HANDLING
// ============================================
function showError(message) {
    const errorEl = document.getElementById('login-error');
    const errorText = document.getElementById('error-text');
    
    if (errorEl && errorText) {
        errorText.textContent = message;
        errorEl.classList.remove('hidden');
    }
}

function hideError() {
    const errorEl = document.getElementById('login-error');
    if (errorEl) {
        errorEl.classList.add('hidden');
    }
}

function getErrorMessage(error) {
    const errorMessages = {
        'auth/invalid-phone-number': 'Invalid phone number format.',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
        'auth/invalid-verification-code': 'Invalid verification code.',
        'auth/code-expired': 'Verification code expired. Please request a new one.',
        'auth/network-request-failed': 'Network error. Please check your connection.'
    };
    
    return errorMessages[error.code] || error.message || 'An error occurred. Please try again.';
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info') {
    // Remove existing toast
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Show toast
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Hide after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============================================
// EVENT LISTENERS - LOGIN PAGE
// ============================================
function initLoginPage() {
    const phoneInput = document.getElementById('phone-input');
    const sendBtn = document.getElementById('send-code-btn');
    const verifyBtn = document.getElementById('verify-code-btn');
    const backBtn = document.getElementById('back-to-phone');
    const resendBtn = document.getElementById('resend-code-btn');
    const codeDigits = document.querySelectorAll('.code-digit');
    
    if (!phoneInput) return; // Not on login page
    
    // Initialize Firebase
    initializeFirebase();
    
    // Check if already logged in
    checkAuthState();
    
    // Phone input formatting
    phoneInput.addEventListener('input', (e) => {
        const formatted = formatPhoneNumber(e.target.value);
        e.target.value = formatted;
        
        // Enable/disable send button
        sendBtn.disabled = !isValidPhoneNumber(formatted);
    });
    
    // Send code button
    sendBtn.addEventListener('click', sendVerificationCode);
    
    // Phone input enter key
    phoneInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !sendBtn.disabled) {
            sendVerificationCode();
        }
    });
    
    // Code digit inputs
    codeDigits.forEach((input, index) => {
        // Only allow numbers
        input.addEventListener('input', (e) => {
            const value = e.target.value.replace(/\D/g, '');
            e.target.value = value;
            
            if (value) {
                e.target.classList.add('filled');
                e.target.classList.remove('error');
                
                // Move to next input
                if (index < 5) {
                    codeDigits[index + 1].focus();
                }
            } else {
                e.target.classList.remove('filled');
            }
            
            // Check if all digits are filled
            const allFilled = Array.from(codeDigits).every(input => input.value.length === 1);
            verifyBtn.disabled = !allFilled;
        });
        
        // Handle backspace
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !e.target.value && index > 0) {
                codeDigits[index - 1].focus();
            }
            
            // Enter to verify
            if (e.key === 'Enter' && !verifyBtn.disabled) {
                verifyCode();
            }
        });
        
        // Handle paste
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
            
            pastedData.split('').forEach((digit, i) => {
                if (codeDigits[i]) {
                    codeDigits[i].value = digit;
                    codeDigits[i].classList.add('filled');
                }
            });
            
            // Focus appropriate input
            const nextEmpty = Array.from(codeDigits).findIndex(input => !input.value);
            if (nextEmpty !== -1) {
                codeDigits[nextEmpty].focus();
            } else {
                codeDigits[5].focus();
            }
            
            // Check if all filled
            const allFilled = pastedData.length === 6;
            verifyBtn.disabled = !allFilled;
        });
    });
    
    // Verify button
    verifyBtn.addEventListener('click', verifyCode);
    
    // Back to phone button
    backBtn.addEventListener('click', backToPhoneStep);
    
    // Resend code button
    resendBtn.addEventListener('click', resendCode);
}

// ============================================
// INITIALIZE
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // Check if we're on login page
    if (document.getElementById('phone-step')) {
        initLoginPage();
    }
});

// Export for use in other files
window.FuelPlannerAuth = {
    getCurrentUser,
    isAdmin,
    logout,
    checkAuthState,
    showToast,
    AUTHORIZED_USERS
};

