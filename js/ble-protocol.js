/**
 * Marstek Venus E BLE Protocol Implementation
 * 
 * This module contains all Web Bluetooth API interactions and Marstek/HM protocol
 * implementation for communicating with Marstek Venus E battery systems.
 * 
 * Features:
 * - BLE device connection/disconnection
 * - Command message creation and sending
 * - Response parsing and notification handling
 * - OTA firmware update protocol
 * - Protocol utility functions
 */

// ========================================
// BLE CONSTANTS AND GLOBAL VARIABLES
// ========================================

const SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';
const START_BYTE = 0x73;
const IDENTIFIER_BYTE = 0x23;

let device = null;
let server = null;
let characteristics = {};
// Note: (window.uiController ? window.uiController.isConnected() : false) and (window.uiController ? window.uiController.getDeviceType() : 'unknown') are managed by ui-controller.js

// OTA-specific globals
let otaInProgress = false;
let otaCurrentChunk = 0;
let otaTotalChunks = 0;
let txCharacteristic = null;  // ff01 - write without response
let rxCharacteristic = null;  // ff02 - notifications
let otaChunkSize = 132;       // Default, calculated from MTU
let pendingAckResolve = null;
let firmwareChecksum = 0;
let firmwareData = null;

// ========================================
// BLE CONNECTION MANAGEMENT
// ========================================

/**
 * Connect to a Marstek BLE device with retry logic
 */
async function connect() {
    try {
        log('🔍 Searching for Marstek devices...');
        
        // Request device with MST prefix filter
        device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'MST' }],
            optionalServices: [SERVICE_UUID]
        });

        log(`📱 Found device: ${device.name}`);
        
        // Try to connect with retry logic
        const maxRetries = 3;
        let connected = false;
        let lastError = null;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                log(`🔄 Connection attempt ${attempt}/${maxRetries}...`);
                
                // Connect to GATT server with timeout
                const connectPromise = device.gatt.connect();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Connection timeout')), 10000)
                );
                
                server = await Promise.race([connectPromise, timeoutPromise]);
                
                // Small delay to ensure connection is stable
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Get service with retry on failure
                let service;
                try {
                    service = await server.getPrimaryService(SERVICE_UUID);
                } catch (serviceError) {
                    log('⚠️ Service not immediately available, waiting...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    service = await server.getPrimaryService(SERVICE_UUID);
                }
                
                // Get all characteristics
                const chars = await service.getCharacteristics();
                characteristics = {};
                
                // Set up characteristics and notifications
                for (const char of chars) {
                    characteristics[char.uuid] = char;
                    
                    // Enable notifications for readable characteristics
                    if (char.properties.notify) {
                        await char.startNotifications();
                        char.addEventListener('characteristicvaluechanged', 
                            createNotificationHandler(char.uuid));
                        log(`📡 Notifications enabled for ${char.uuid.slice(-4).toUpperCase()}`);
                    }
                }
                
                connected = true;
                break; // Success, exit retry loop
                
            } catch (attemptError) {
                lastError = attemptError;
                log(`⚠️ Attempt ${attempt} failed: ${attemptError.message}`);
                
                if (attempt < maxRetries) {
                    // Disconnect if partially connected before retry
                    if (server && server.connected) {
                        try {
                            server.disconnect();
                        } catch (e) {}
                    }
                    
                    // Wait before retry (longer wait for each attempt)
                    const waitTime = attempt * 2000;
                    log(`⏳ Waiting ${waitTime/1000}s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        }
        
        if (!connected) {
            throw lastError || new Error('Failed to connect after multiple attempts');
        }

        // Handle disconnection
        device.addEventListener('gattserverdisconnected', () => {
            log('❌ Device disconnected');
            if (window.uiController && window.uiController.updateStatus) {
                window.uiController.updateStatus(false);
            }
        });

        // Update connection status
        if (window.uiController && window.uiController.updateStatus) {
            window.uiController.updateStatus(true, device.name);
        }
        log(`✅ Connected to ${device.name}!`);

        // Determine device type from name
        if (device.name.includes('ACCP')) {
            if (window.uiController) window.uiController.setDeviceType('battery');
            log('🔋 Detected: Battery device (Venus E)');
        } else if (device.name.includes('TPM')) {
            if (window.uiController) window.uiController.setDeviceType('meter');
            log('📊 Detected: CT meter device');
        }

    } catch (error) {
        log(`❌ Connection failed: ${error.message}`);
        if (window.uiController && window.uiController.updateStatus) {
            window.uiController.updateStatus(false);
        }
        
        // Clean up on failure
        device = null;
        server = null;
        characteristics = {};
    }
}

/**
 * Disconnect from the BLE device
 */
function disconnect() {
    if (device && device.gatt.connected) {
        device.gatt.disconnect();
        log('🔌 Disconnected from device');
    }
    
    // Reset state
    device = null;
    server = null;
    characteristics = {};
    // Connection state and device type reset handled by ui-controller
    
    if (window.uiController && window.uiController.updateStatus) {
        window.uiController.updateStatus(false);
    }
}

/**
 * Disconnect from all paired Bluetooth devices
 */
async function disconnectAll() {
    log('🔌 Disconnecting from all Bluetooth devices...');
    
    try {
        // First disconnect current device
        disconnect();
        
        // Get all paired devices and disconnect them
        if (navigator.bluetooth && navigator.bluetooth.getDevices) {
            const devices = await navigator.bluetooth.getDevices();
            let disconnectedCount = 0;
            
            for (const pairedDevice of devices) {
                try {
                    if (pairedDevice.gatt && pairedDevice.gatt.connected) {
                        await pairedDevice.gatt.disconnect();
                        disconnectedCount++;
                        log(`🔌 Disconnected from ${pairedDevice.name || 'Unknown Device'}`);
                    }
                } catch (error) {
                    log(`⚠️ Error disconnecting from ${pairedDevice.name || 'Unknown Device'}: ${error.message}`);
                }
            }
            
            if (disconnectedCount > 0) {
                log(`✅ Disconnected from ${disconnectedCount} device(s)`);
            } else {
                log('ℹ️ No connected devices found');
            }
        } else {
            log('ℹ️ Bluetooth device enumeration not available in this browser');
        }
    } catch (error) {
        log(`❌ Error during disconnect all: ${error.message}`);
    }
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Log messages to console and UI log element
 * @param {string} message - Message to log
 */
function log(message) {
    console.log(message);
    
    // Also log to UI if available
    if (window.uiController && window.uiController.log) {
        window.uiController.log(message);
    } else {
        // Fallback to direct DOM manipulation
        const logElement = document.getElementById('log');
        if (logElement) {
            const entry = document.createElement('div');
            entry.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
            logElement.appendChild(entry);
            logElement.scrollTop = logElement.scrollHeight;
        }
    }
}

// ========================================
// PROTOCOL MESSAGE CREATION
// ========================================

/**
 * Format bytes array as hex string for logging
 * @param {ArrayBuffer|Uint8Array} data - Data to format
 * @returns {string} Formatted hex string
 */
function formatBytes(data) {
    return Array.from(new Uint8Array(data.buffer || data))
        .map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Calculate XOR checksum for array of bytes
 * @param {Array|Uint8Array} bytes - Bytes to checksum
 * @returns {number} XOR checksum
 */
function calculateXORChecksum(bytes) {
    let xor = 0;
    for (let i = 0; i < bytes.length; i++) {
        xor ^= bytes[i];
    }
    return xor;
}

/**
 * Format hex dump for detailed byte analysis
 * @param {Uint8Array} bytes - Bytes to format
 * @returns {string} Formatted hex dump
 */
function formatHexDump(bytes) {
    let hexDump = '';
    for (let i = 0; i < bytes.length; i += 16) {
        // Address
        hexDump += i.toString(16).padStart(4, '0') + ': ';
        
        // Hex bytes
        let hexPart = '';
        let asciiPart = '';
        for (let j = 0; j < 16; j++) {
            if (i + j < bytes.length) {
                const byte = bytes[i + j];
                hexPart += byte.toString(16).padStart(2, '0') + ' ';
                // ASCII representation (printable chars only)
                asciiPart += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';
            } else {
                hexPart += '   ';
            }
            // Add extra space in middle
            if (j === 7) hexPart += ' ';
        }
        
        hexDump += hexPart + ' |' + asciiPart + '|\n';
    }
    return hexDump;
}

// ========================================
// MESSAGE CREATION FUNCTIONS
// ========================================

/**
 * Create standard command message for Marstek protocol
 * @param {number} commandType - Command type byte
 * @param {Array|null} payload - Optional payload bytes
 * @returns {Uint8Array} Complete command message with checksum
 */
function createCommandMessage(commandType, payload = null) {
    const header = [START_BYTE, 0, IDENTIFIER_BYTE, commandType];
    const payloadArray = payload ? Array.from(payload) : [];
    // Reverting to original calculation - the 0x05 length was apparently correct
    const messageLength = header.length + payloadArray.length + 1;
    header[1] = messageLength;
    const message = [...header, ...payloadArray];
    const checksum = message.reduce((xor, byte) => xor ^ byte, 0);
    message.push(checksum);
    return new Uint8Array(message);
}

/**
 * Create meter IP command message using alternative protocol format
 * @param {number} commandType - Command type byte
 * @param {Array|null} payload - Optional payload bytes
 * @returns {Uint8Array} Complete meter IP command message
 */
function createMeterIPMessage(commandType, payload = null) {
    // Alternative format for meter IP commands based on protocol analysis
    // Frame: [0x73] [LEN] [0x23] [CMD] [PAYLOAD] [XOR]
    // LEN = count of bytes from 0x23 through checksum
    // XOR = 0x23 ^ CMD ^ PAYLOAD bytes
    
    const payloadArray = payload ? Array.from(payload) : [];
    const len = 4 + payloadArray.length; // 0x23 + cmd + payload + checksum = 4 + payload length
    
    const message = [START_BYTE, len, IDENTIFIER_BYTE, commandType, ...payloadArray];
    
    // XOR only over [0x23, cmd, payload] - not including 0x73, len, or checksum
    let checksum = IDENTIFIER_BYTE ^ commandType;
    for (const byte of payloadArray) {
        checksum ^= byte;
    }
    message.push(checksum);
    
    return new Uint8Array(message);
}

/**
 * Create standard HM protocol frame for regular commands
 * @param {number} command - Command byte (e.g., 0x1F)
 * @param {Array} payload - Payload bytes
 * @returns {Uint8Array} Complete HM protocol frame
 */
function createHMFrame(command, payload = []) {
    const frame = [];
    frame.push(0x73);                           // Start byte
    
    const contentLength = 2 + payload.length;   // 0x23 + CMD + payload
    frame.push(contentLength);                  // Length byte
    
    frame.push(0x23);                          // Protocol identifier
    frame.push(command);                       // Command byte
    
    // Add payload
    payload.forEach(byte => frame.push(byte));
    
    // Calculate XOR checksum: 0x23 ^ CMD ^ payload bytes
    let checksum = 0x23 ^ command;
    payload.forEach(byte => checksum ^= byte);
    frame.push(checksum);
    
    return new Uint8Array(frame);
}

/**
 * Create BLE OTA frame for firmware update commands
 * @param {number} command - OTA command byte (0x50, 0x51, 0x52)
 * @param {number} reserved - Reserved byte (typically 0x10)
 * @param {Array} payload - Payload bytes
 * @returns {Uint8Array} Complete OTA frame
 */
function createBLEOTAFrame(command, reserved, payload = []) {
    const frame = [];
    frame.push(0x73);                    // Header byte
    
    // For BLE OTA frames, length should be the payload + overhead size
    // Based on the frame structure: [0x73] [LEN_LO] [LEN_HI] [CMD] [RESERVED] [PAYLOAD] [CHECKSUM]
    // Length field represents: CMD(1) + RESERVED(1) + PAYLOAD + CHECKSUM(1)
    const totalLength = 1 + 1 + payload.length + 1;
    frame.push(totalLength & 0xFF);      // Length low byte (LE)  
    frame.push((totalLength >> 8) & 0xFF); // Length high byte (LE)
    
    frame.push(command);                 // Command byte (0x50, 0x51, 0x52)
    frame.push(reserved);                // Reserved byte (0x10)
    frame.push(...payload);              // Payload
    
    // Calculate XOR checksum over all previous bytes
    let checksum = 0;
    for (const byte of frame) {
        checksum ^= byte;
    }
    frame.push(checksum);
    
    return new Uint8Array(frame);
}

// ========================================
// CONNECTION MANAGEMENT
// ========================================

// updateStatus is handled by ui-controller.js


// ========================================
// COMMAND SENDING FUNCTIONS
// ========================================

/**
 * Send standard command to BLE device
 * @param {number} commandType - Command type byte
 * @param {string} commandName - Human-readable command name for logging
 * @param {Array|null} payload - Optional payload bytes
 * @param {number} retryCount - Number of retry attempts (default 0)
 */
async function sendCommand(commandType, commandName, payload = null, retryCount = 0) {
    if (!(window.uiController ? window.uiController.isConnected() : false)) return;
    
    try {
        const command = createCommandMessage(commandType, payload);
        window.currentCommand = commandName;
        window.lastCommandTime = Date.now();
        
        log(`📤 Sending ${commandName}...`);
        log(`📋 Frame: ${formatBytes(command)}`);
        
        const writeChars = Object.values(characteristics).filter(char => 
            char.properties.write || char.properties.writeWithoutResponse
        );
        
        if (writeChars.length === 0) {
            log('❌ No writable characteristics found');
            return;
        }
        
        const writeChar = writeChars[0];
        await writeChar.writeValueWithoutResponse(command);
        
        // Set up timeout for retry
        setTimeout(async () => {
            // Check if we got a response (currentCommand gets cleared when response arrives)
            if (window.currentCommand === commandName && 
                Date.now() - window.lastCommandTime > 2900) {
                
                if (retryCount < 2) {
                    log(`⏱️ No response, retrying ${commandName} (attempt ${retryCount + 2}/3)...`);
                    await sendCommand(commandType, commandName, payload, retryCount + 1);
                } else {
                    log(`❌ No response for ${commandName} after 3 attempts`);
                    window.currentCommand = null;
                }
            }
        }, 3000);
        
    } catch (error) {
        log(`❌ Failed to send ${commandName}: ${error.message}`);
        
        // Retry on error
        if (retryCount < 2) {
            log(`🔄 Retrying ${commandName} due to error (attempt ${retryCount + 2}/3)...`);
            setTimeout(() => {
                sendCommand(commandType, commandName, payload, retryCount + 1);
            }, 1000);
        }
    }
}

/**
 * Send meter IP command using alternative protocol
 * @param {number} commandType - Command type byte
 * @param {string} commandName - Human-readable command name for logging
 * @param {Array|null} payload - Optional payload bytes
 * @param {number} retryCount - Number of retry attempts (default 0)
 */
async function sendMeterIPCommand(commandType, commandName, payload = null, retryCount = 0) {
    if (!(window.uiController ? window.uiController.isConnected() : false)) return;
    
    try {
        const command = createMeterIPMessage(commandType, payload);
        window.currentCommand = commandName;
        window.lastCommandTime = Date.now();
        
        log(`📤 Sending ${commandName} (Alternative Protocol)...`);
        log(`📋 Frame: ${formatBytes(command)}`);
        
        const writeChars = Object.values(characteristics).filter(char => 
            char.properties.write || char.properties.writeWithoutResponse
        );
        
        if (writeChars.length === 0) {
            log('❌ No writable characteristics found');
            return;
        }
        
        const writeChar = writeChars[0];
        await writeChar.writeValueWithoutResponse(command);
        
        // Set up timeout for retry
        setTimeout(async () => {
            // Check if we got a response (currentCommand gets cleared when response arrives)
            if (window.currentCommand === commandName && 
                Date.now() - window.lastCommandTime > 2900) {
                
                if (retryCount < 2) {
                    log(`⏱️ No response, retrying ${commandName} (attempt ${retryCount + 2}/3)...`);
                    await sendMeterIPCommand(commandType, commandName, payload, retryCount + 1);
                } else {
                    log(`❌ No response for ${commandName} after 3 attempts`);
                    window.currentCommand = null;
                }
            }
        }, 3000);
        
    } catch (error) {
        log(`❌ Failed to send ${commandName}: ${error.message}`);
        
        // Retry on error
        if (retryCount < 2) {
            log(`🔄 Retrying ${commandName} due to error (attempt ${retryCount + 2}/3)...`);
            setTimeout(() => {
                sendMeterIPCommand(commandType, commandName, payload, retryCount + 1);
            }, 1000);
        }
    }
}

// ========================================
// NOTIFICATION AND RESPONSE HANDLING
// ========================================

/**
 * Create notification handler for BLE characteristic
 * @param {string} charUuid - Characteristic UUID
 * @returns {Function} Notification handler function
 */
function createNotificationHandler(charUuid) {
    return function(event) {
        const data = event.target.value;
        const bytes = new Uint8Array(data.buffer);
        
        log(`📨 Response received (${bytes.length} bytes): ${formatBytes(bytes)}`);
        
        // Check if this is an OTA activation response (cmd 0x1F)
        if (window.otaActivationResolve && bytes.length >= 5 && bytes[0] === 0x73 && bytes[2] === 0x23 && bytes[3] === 0x1F) {
            log('🔍 Detected upgrade mode activation response');
            const payload = bytes.slice(4, -1); // Extract payload (skip header and checksum)
            log(`📥 Upgrade mode payload: [${Array.from(payload).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
            
            // Firmware analysis: payload 0x01 = "OTA armed" 
            if (payload.length >= 1 && payload[0] === 0x01) {
                log('✅ OTA activation confirmed: device is armed for upgrade (payload 0x01)');
                log('✅ Upgrade mode activated - device ready for OTA');
                window.otaActivationResolve(true);
            } else {
                const status = payload.length >= 1 ? `0x${payload[0].toString(16).padStart(2, '0')}` : 'empty';
                log(`⚠️ Unexpected OTA activation payload: expected 0x01, got 0x${status}`);
                log(`❌ Upgrade mode activation failed - status: ${status}`);
                window.otaActivationResolve(false);
            }
            
            window.otaActivationResolve = null;
            window.currentCommand = null;
            return;
        }
        
        // Check if this looks like an OTA/BLE frame response (for firmware update ACKs)
        if (bytes.length >= 6 && bytes[0] === 0x73) {
            const frameLength = bytes[1] | (bytes[2] << 8);
            if (frameLength > 5 && bytes[3] === 0xFF && bytes[4] === 0x01) {
                // This looks like an OTA ACK - handle it
                handleOTAAck(bytes);
                return;
            }
        }
        
        // Handle regular command responses
        if (window.currentCommand) {
            // Use the comprehensive data parser if available
            if (window.dataParser && window.dataParser.parseResponse) {
                const parsed = window.dataParser.parseResponse(bytes, window.currentCommand);
                if (window.uiController && window.uiController.displayData) {
                    window.uiController.displayData(parsed);
                } else {
                    // Fallback display
                    const dataDisplay = document.getElementById('dataDisplay');
                    if (dataDisplay) {
                        dataDisplay.innerHTML = parsed;
                    }
                }
            } else {
                // Fallback to basic display
                log('⚠️ Data parser not available, showing raw data');
                log(`Raw response: ${formatBytes(bytes)}`);
            }
            window.currentCommand = null;
        }
    };
}


// ========================================
// OTA FIRMWARE UPDATE FUNCTIONS
// ========================================

/**
 * Analyze firmware file to calculate checksum and detect type
 * @param {ArrayBuffer} firmwareArrayBuffer - Firmware data
 * @returns {Object} Analysis results with checksum, type, and size
 */
function analyzeFirmware(firmwareArrayBuffer) {
    // Calculate ones' complement checksum as expected by Marstek bootloader
    const bytes = new Uint8Array(firmwareArrayBuffer);
    let sum = 0;
    
    // Sum all bytes (JavaScript handles 32-bit overflow automatically)
    for (let i = 0; i < bytes.length; i++) {
        sum += bytes[i];
    }
    
    // Apply 32-bit mask and ones' complement
    sum = sum >>> 0; // Convert to unsigned 32-bit
    const checksum = (~sum) >>> 0; // Ones' complement and convert to unsigned 32-bit
    
    // Detect firmware type by checking for VenusC signature at offset 0x50004
    let firmwareType = 'Unknown';
    let sizeWarning = '';
    const signatureOffset = 0x50004;
    
    if (bytes.length > signatureOffset + 10) {
        // Large firmware files - check for EMS signature
        const signatureBytes = bytes.slice(signatureOffset, signatureOffset + 10);
        const signatureStr = new TextDecoder('utf-8', { fatal: false }).decode(signatureBytes);
        
        if (signatureStr.includes('VenusC')) {
            firmwareType = 'EMS/Control Firmware (VenusC signature found)';
        } else {
            // Check if the area contains mostly null bytes or valid data
            const hasData = signatureBytes.some(b => b !== 0x00 && b !== 0xFF);
            if (hasData) {
                firmwareType = 'BMS Firmware (no VenusC signature)';
            } else {
                firmwareType = 'Unknown (signature area empty)';
            }
        }
    } else if (bytes.length >= 32768) {
        // Smaller firmware files - likely BMS firmware
        firmwareType = 'BMS Firmware (size suggests BMS)';
    } else if (bytes.length >= 1024) {
        // Small files - could be firmware but unusual
        firmwareType = 'Unknown (small size - proceed with caution)';
        sizeWarning = '⚠️ File size is unusually small for firmware';
    } else {
        // Very small files - likely not firmware but allow user to proceed
        firmwareType = 'Unknown (very small - likely not firmware)';
        sizeWarning = '⚠️ File size is very small - this may not be valid firmware';
    }
    
    log(`📊 Firmware analysis:`);
    log(`   Size: ${bytes.length} bytes`);
    log(`   Type: ${firmwareType}`);
    log(`   Sum: 0x${sum.toString(16).padStart(8, '0')}`);
    log(`   Checksum: 0x${checksum.toString(16).padStart(8, '0')} (~sum)`);
    if (sizeWarning) {
        log(`   ${sizeWarning}`);
    }
    
    return { checksum, type: firmwareType, size: bytes.length, warning: sizeWarning };
}

/**
 * Handle OTA notification responses
 * @param {Event} event - BLE characteristic change event
 */
function handleNotification(event) {
    const value = new Uint8Array(event.target.value.buffer);
    
    // Parse OTA frame from notification
    if (value.length < 6 || value[0] !== 0x73) {
        log(`❌ Bad notification header: ${Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        return;
    }
    
    const declaredLength = value[1] | (value[2] << 8);
    if (declaredLength !== value.length) {
        log(`❌ Length mismatch: declared ${declaredLength}, got ${value.length}`);
        return;
    }
    
    const cmd = value[3];
    const reserved = value[4];
    
    // Verify XOR checksum
    let xor = 0;
    for (let i = 0; i < value.length - 1; i++) {
        xor ^= value[i];
    }
    if (xor !== value[value.length - 1]) {
        log(`❌ Bad XOR checksum: expected ${xor.toString(16)}, got ${value[value.length - 1].toString(16)}`);
        return;
    }
    
    const payload = value.slice(5, -1);
    log(`📥 Received ACK: cmd=0x${cmd.toString(16)}, payload=[${Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
    
    // Resolve pending ACK promise
    if (pendingAckResolve) {
        pendingAckResolve({
            ok: true,
            cmd: cmd,
            reserved: reserved,
            payload: payload
        });
        pendingAckResolve = null;
    }
}

/**
 * Wait for ACK response from device
 * @param {number} expectedCmd - Expected command in ACK
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise} Promise resolving to ACK response
 */
async function waitForAck(expectedCmd, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        pendingAckResolve = (ack) => {
            if (ack.cmd === expectedCmd) {
                resolve(ack);
            } else {
                resolve({
                    ok: false,
                    reason: `unexpected cmd: expected 0x${expectedCmd.toString(16)}, got 0x${ack.cmd.toString(16)}`
                });
            }
        };
        
        setTimeout(() => {
            if (pendingAckResolve) {
                pendingAckResolve = null;
                resolve({ ok: false, reason: "timeout" });
            }
        }, timeoutMs);
    });
}

/**
 * Connect and prepare OTA characteristics
 */
async function connectAndPrepareOTA() {
    if (!device) {
        throw new Error("No device connected");
    }
    
    // Find TX and RX characteristics
    const service = await device.gatt.getPrimaryService('0000ff00-0000-1000-8000-00805f9b34fb');
    txCharacteristic = await service.getCharacteristic('0000ff01-0000-1000-8000-00805f9b34fb');
    rxCharacteristic = await service.getCharacteristic('0000ff02-0000-1000-8000-00805f9b34fb');
    
    // Enable notifications on RX characteristic
    await rxCharacteristic.startNotifications();
    rxCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);
    log('✅ Notifications enabled on RX characteristic (ff02)');
    
    // Use fixed 128-byte chunks as per protocol specification
    otaChunkSize = 128;
    log(`📏 Using protocol chunk size: ${otaChunkSize} bytes (128 data + 4 offset)`);
    
    // Analyze firmware: checksum + type detection
    const analysis = analyzeFirmware(firmwareData);
    firmwareChecksum = analysis.checksum;
    log(`🔑 Firmware ready for upload`);
}

/**
 * Send OTA activation command
 * @returns {Promise<boolean>} Success status
 */
async function sendOTAActivate() {
    return new Promise((resolve) => {
        log('🔄 Activating upgrade mode with cmd 0x1F (firmware confirmed)...');
        
        // Set up response handler for upgrade mode activation  
        window.otaActivationResolve = resolve;
        window.currentCommand = 0x1F;
        
        // Send OTA activation command based on firmware disassembly (both versions confirm 0x1F)
        // Both original and v153 firmware: 0x1F checks magic bytes [0x0A, 0x0B, 0x0C]
        // btsnoop showing 0x13 likely from different firmware/device version
        sendCommand(0x1F, 'Upgrade Mode Activation', [0x0A, 0x0B, 0x0C]);
        
        // Set timeout in case no response comes
        setTimeout(() => {
            if (window.otaActivationResolve) {
                window.otaActivationResolve = null;
                log('❌ OTA activation timeout - no response received');
                resolve(false);
            }
        }, 5000);
    });
}

/**
 * Send firmware size and checksum to device
 * @param {number} firmwareSize - Size of firmware in bytes
 * @returns {Promise<boolean>} Success status
 */
async function sendFirmwareSize(firmwareSize) {
    if (!txCharacteristic) {
        log('❌ TX characteristic not ready');
        return false;
    }

    try {
        log(`📏 Sending firmware size: ${firmwareSize} bytes with checksum: 0x${firmwareChecksum.toString(16)}`);
        
        // Step 2: Send firmware length in 8-byte payload: size LE (4) + checksum LE (4)
        const sizePayload = [
            firmwareSize & 0xFF,
            (firmwareSize >> 8) & 0xFF,
            (firmwareSize >> 16) & 0xFF,
            (firmwareSize >> 24) & 0xFF,
            firmwareChecksum & 0xFF,
            (firmwareChecksum >> 8) & 0xFF,
            (firmwareChecksum >> 16) & 0xFF,
            (firmwareChecksum >> 24) & 0xFF
        ];
        
        log(`🔍 Size payload (${sizePayload.length} bytes): [${sizePayload.map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        
        const frame = createBLEOTAFrame(0x50, 0x10, sizePayload);
        log(`🔍 Size frame (${frame.length} bytes): ${formatBytes(frame)}`);
        await txCharacteristic.writeValueWithoutResponse(frame);
        log('✅ Firmware size sent, waiting for ACK...');
        
        // Wait for ACK (device should echo the same cmd=0x50)
        const ack = await waitForAck(0x50, 2000);
        if (!ack.ok) {
            log(`❌ Size ACK failed: ${ack.reason}`);
            return false;
        }
        
        // Verify device echoed our firmware checksum in the ACK payload
        if (ack.payload.length >= 8) {
            const echoedChecksum = ack.payload[4] | (ack.payload[5] << 8) | (ack.payload[6] << 16) | (ack.payload[7] << 24);
            if (echoedChecksum === firmwareChecksum) {
                log(`✅ Firmware checksum verified: 0x${echoedChecksum.toString(16)}`);
            } else {
                log(`⚠️ Firmware checksum mismatch: sent 0x${firmwareChecksum.toString(16)}, got 0x${echoedChecksum.toString(16)}`);
            }
        }
        
        log('✅ Firmware size confirmed');
        return true;
    } catch (error) {
        log(`❌ Failed to send firmware size: ${error.message}`);
        return false;
    }
}

/**
 * Send firmware data chunk
 * @param {Uint8Array} chunkData - Chunk data to send
 * @param {number} offset - Offset in firmware file
 * @param {number} chunkIndex - Current chunk index
 * @param {number} totalChunks - Total number of chunks
 * @returns {Promise<boolean>} Success status
 */
async function sendFirmwareChunk(chunkData, offset, chunkIndex, totalChunks) {
    if (!txCharacteristic) {
        log('❌ TX characteristic not ready');
        return false;
    }

    try {
        // Step 3: Send firmware chunk with cmd=0x51
        // Payload: 4-byte offset (LE) + 128 bytes of firmware data
        const payload = [
            offset & 0xFF,
            (offset >> 8) & 0xFF,
            (offset >> 16) & 0xFF,
            (offset >> 24) & 0xFF,
            ...Array.from(chunkData)
        ];
        
        const frame = createBLEOTAFrame(0x51, 0x10, payload);
        await txCharacteristic.writeValueWithoutResponse(frame);
        
        // Update progress
        const progress = Math.round((chunkIndex / totalChunks) * 100);
        if (document.getElementById('otaProgress')) {
            document.getElementById('otaProgress').style.width = `${progress}%`;
        }
        if (document.getElementById('otaStatus')) {
            document.getElementById('otaStatus').textContent = 
                `Uploading: ${chunkIndex}/${totalChunks} chunks (${progress}%)`;
        }
        
        log(`📤 Sent chunk ${chunkIndex}/${totalChunks} at offset 0x${offset.toString(16)} (${chunkData.length} bytes)`);
        
        // Wait for ACK (cmd=0x51) with echoed offset
        const ack = await waitForAck(0x51, 1500);
        if (!ack.ok) {
            log(`❌ Chunk ${chunkIndex} ACK failed: ${ack.reason}`);
            return false;
        }
        
        // Verify device echoed back the correct offset
        if (ack.payload.length >= 4) {
            const echoedOffset = ack.payload[0] | (ack.payload[1] << 8) | (ack.payload[2] << 16) | (ack.payload[3] << 24);
            if (echoedOffset === offset) {
                log(`✅ Chunk ${chunkIndex} confirmed at offset 0x${offset.toString(16)}`);
            } else {
                log(`⚠️ Offset mismatch: sent 0x${offset.toString(16)}, got 0x${echoedOffset.toString(16)}`);
            }
        } else {
            log(`✅ Chunk ${chunkIndex} confirmed (no offset echo)`);
        }
        
        return true;
    } catch (error) {
        log(`❌ Failed to send chunk ${chunkIndex}: ${error.message}`);
        return false;
    }
}

/**
 * Send OTA finalization command
 * @returns {Promise<boolean>} Success status
 */
async function sendOTAFinalize() {
    if (!txCharacteristic) {
        log('❌ TX characteristic not ready');
        return false;
    }

    try {
        log('🏁 Sending OTA finalization command...');
        // Step 4: Send finalize command with cmd=0x52 and empty payload
        const frame = createBLEOTAFrame(0x52, 0x10, []);
        await txCharacteristic.writeValueWithoutResponse(frame);
        log('✅ OTA finalize command sent, waiting for confirmation...');
        
        // Wait for ACK (cmd=0x52) with payload indicating success (0x01) or failure
        const ack = await waitForAck(0x52, 3000);
        if (!ack.ok) {
            log(`❌ Finalize ACK failed: ${ack.reason}`);
            return false;
        }
        
        // For 0x52 ACK: payload[0] == 0x01 means success
        if (ack.payload.length >= 1 && ack.payload[0] === 0x01) {
            log('✅ OTA finalization successful - device will restart');
            return true;
        } else {
            const status = ack.payload.length >= 1 ? `0x${ack.payload[0].toString(16)}` : 'empty';
            log(`❌ OTA finalization failed - status: ${status}`);
            return false;
        }
    } catch (error) {
        log(`❌ Failed to finalize OTA update: ${error.message}`);
        return false;
    }
}

/**
 * Perform complete OTA firmware update
 */
async function performOTAUpdate() {
    if (!firmwareData) {
        log('❌ No firmware file selected');
        return;
    }

    if (otaInProgress) {
        log('⚠️ OTA update already in progress');
        return;
    }

    otaInProgress = true;
    otaCurrentChunk = 0;
    
    try {
        log(`🚀 Starting OTA update...`);
        log(`📄 Firmware size: ${firmwareData.byteLength} bytes`);
        
        // Step 0: Connect and prepare OTA characteristics
        await connectAndPrepareOTA();
        
        // Calculate chunks using computed chunk size
        otaTotalChunks = Math.ceil(firmwareData.byteLength / otaChunkSize);
        log(`📦 Total chunks: ${otaTotalChunks} (${otaChunkSize} bytes each)`);
        
        // Step 1: Send activation command 0x1F to enter upgrade mode
        if (!await sendOTAActivate()) {
            throw new Error('Failed to activate upgrade mode');
        }
        
        // Step 2: Send firmware size with session token
        if (!await sendFirmwareSize(firmwareData.byteLength)) {
            throw new Error('Failed to send firmware size');
        }
        
        // Step 3: Send firmware data in chunks
        log('📤 Starting firmware data transfer...');
        let offset = 0;
        let chunkIndex = 0;
        
        while (offset < firmwareData.byteLength) {
            const end = Math.min(offset + otaChunkSize, firmwareData.byteLength);
            const chunk = new Uint8Array(firmwareData.slice(offset, end));
            
            let retryCount = 0;
            let chunkSent = false;
            
            while (!chunkSent && retryCount < 3) {
                try {
                    if (!await sendFirmwareChunk(chunk, offset, chunkIndex + 1, otaTotalChunks)) {
                        throw new Error(`Failed to send chunk ${chunkIndex + 1}`);
                    }
                    chunkSent = true;
                    offset += chunk.length;
                    chunkIndex++;
                } catch (error) {
                    retryCount++;
                    log(`⚠️ Retry ${retryCount}/3 for chunk ${chunkIndex + 1}: ${error.message}`);
                    if (retryCount >= 3) {
                        throw new Error(`Failed to send chunk ${chunkIndex + 1} after 3 retries`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 100)); // Small backoff
                }
            }
        }
        
        // Step 4: Finalize OTA update
        log('🏁 Finalizing OTA update...');
        if (!await sendOTAFinalize()) {
            throw new Error('Failed to finalize OTA update');
        }
        
        log('✅ OTA update completed successfully!');
        if (document.getElementById('otaStatus')) {
            document.getElementById('otaStatus').textContent = 'Update completed! Device will restart...';
        }
        
    } catch (error) {
        log(`❌ OTA update failed: ${error.message}`);
        if (document.getElementById('otaStatus')) {
            document.getElementById('otaStatus').textContent = `Update failed: ${error.message}`;
        }
    } finally {
        otaInProgress = false;
    }
}

/**
 * Handle firmware file selection
 * @param {Event} event - File input change event
 */
function handleFirmwareFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    log(`📁 Selected firmware file: ${file.name} (${file.size} bytes)`);
    
    const reader = new FileReader();
    reader.onload = function(e) {
        firmwareData = e.target.result;
        
        // Analyze firmware to get type and checksum info
        const analysis = analyzeFirmware(firmwareData);
        
        // Update UI with detailed firmware info
        if (document.getElementById('otaFileInfo')) {
            let warningHtml = '';
            if (analysis.warning) {
                warningHtml = `<br><span style="color: #ff6b35; font-weight: bold;">${analysis.warning}</span>`;
            }
            document.getElementById('otaFileInfo').innerHTML = `
                <strong>File:</strong> ${file.name} (${file.size.toLocaleString()} bytes)<br>
                <strong>Type:</strong> ${analysis.type}<br>
                <strong>Checksum:</strong> 0x${analysis.checksum.toString(16).padStart(8, '0').toUpperCase()}${warningHtml}
            `;
        }
        
        // Enable start button only if connected and file loaded
        const startBtn = document.getElementById('otaStartBtn');
        if (startBtn && device && device.gatt && device.gatt.connected) {
            startBtn.disabled = false;
        }
        
        // Show progress container
        if (document.getElementById('otaProgressContainer')) {
            document.getElementById('otaProgressContainer').style.display = 'block';
        }
        if (document.getElementById('otaStatus')) {
            document.getElementById('otaStatus').textContent = 'Ready to start...';
        }
        
        log('✅ Firmware file analyzed and ready for upload');
    };
    reader.readAsArrayBuffer(file);
}

// ========================================
// SPECIALIZED COMMAND FUNCTIONS
// ========================================

/**
 * Set current date and time on device
 */
function setCurrentDateTime() {
    if (!(window.uiController ? window.uiController.isConnected() : false)) return;
    
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const second = now.getSeconds();
    
    // Format: [year_low, year_high, month, day, hour, minute, second]
    const payload = [
        year & 0xFF,           // Year low byte
        (year >> 8) & 0xFF,    // Year high byte  
        month,
        day,
        hour,
        minute,
        second
    ];
    
    log(`🕐 Setting time to ${year}-${month.toString().padStart(2,'0')}-${day.toString().padStart(2,'0')} ${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}:${second.toString().padStart(2,'0')}`);
    sendCommand(0x0B, 'Set Date/Time', payload);
}

/**
 * Set local API port with user input
 */
function setLocalApiPort() {
    if (!(window.uiController ? window.uiController.isConnected() : false)) return;
    
    const portInput = prompt('Enter the local API port number (1-65535):', '8080');
    if (!portInput) return;
    
    const port = parseInt(portInput);
    if (isNaN(port) || port < 1 || port > 65535) {
        log('❌ Invalid port number. Must be between 1 and 65535.');
        return;
    }
    
    // Format: [enable_flag, port_low, port_high]
    const payload = [
        0x01,                  // Enable flag (1 = enable with port)
        port & 0xFF,           // Port low byte
        (port >> 8) & 0xFF     // Port high byte
    ];
    
    log(`🌐 Setting local API port to ${port}`);
    sendCommand(0x28, `Set Local API Port ${port}`, payload);
}

/**
 * Disconnect from all Bluetooth devices
 */
async function disconnectAll() {
    log('🔌 Disconnecting from all Bluetooth devices...');
    try {
        disconnect();
        if (navigator.bluetooth && navigator.bluetooth.getDevices) {
            const devices = await navigator.bluetooth.getDevices();
            let disconnectedCount = 0;
            for (const pairedDevice of devices) {
                if (pairedDevice.gatt && pairedDevice.gatt.connected) {
                    await pairedDevice.gatt.disconnect();
                    disconnectedCount++;
                }
            }
            if (disconnectedCount > 0) {
                log(`✅ Disconnected from ${disconnectedCount} additional paired device(s)`);
            } else {
                log('ℹ️ No additional paired devices were connected');
            }
        }
        log('✅ Disconnect all completed');
    } catch (error) {
        log(`❌ Error during disconnect all: ${error.message}`);
    }
}

/**
 * Run comprehensive test sequence
 */
async function runAllTests() {
    if (!(window.uiController ? window.uiController.isConnected() : false)) return;
    
    log('🧪 Starting comprehensive test sequence...');
    clearAll();
    
    const commands = [
        { cmd: 0x03, name: 'Runtime Info' },
        { cmd: 0x04, name: 'Device Info' },
        { cmd: 0x08, name: 'WiFi Info' },
        { cmd: 0x0D, name: 'System Data' },
        { cmd: 0x13, name: 'Error Codes' },
        { cmd: 0x14, name: 'BMS Data' },
        { cmd: 0x1A, name: 'Config Data' },
        { cmd: 0x1C, name: 'Event Log' },
        { cmd: 0x21, name: 'Read Meter IP', payload: [0x0B] },
        { cmd: 0x24, name: 'Network Info' }
    ];
    
    for (const test of commands) {
        log(`\n📋 Running test: ${test.name}`);
        await sendCommand(test.cmd, test.name, test.payload);
        // Wait 1 second between commands to avoid overwhelming the device
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    log('\n✅ All tests completed! Check the hex dumps above for analysis.');
}



// ========================================
// CONFIGURATION MANAGEMENT FUNCTIONS
// ========================================

/**
 * Send configuration write command with user input
 * Command 80 (0x80) with sub-command 12 (0x0C) for XID config
 */
async function sendConfigWriteCommand() {
    if (!(window.uiController ? window.uiController.isConnected() : false)) {
        log('❌ Not connected to device');
        return;
    }
    
    // Prompt for configuration data with security warning
    const confirmWrite = confirm(
        '⚠️ WARNING: This will modify device server credentials!\n\n' +
        'This command writes server configuration including:\n' +
        '• Server URL\n' +
        '• Port number\n' +
        '• Username\n' +
        '• Password\n\n' +
        'Incorrect settings may prevent remote monitoring.\n\n' +
        'Do you want to continue?'
    );
    
    if (!confirmWrite) {
        log('ℹ️ Configuration write cancelled by user');
        return;
    }
    
    // Get configuration details from user
    const url = prompt("Enter server URL (e.g., server.example.com):");
    if (!url) {
        log('❌ Server URL is required');
        return;
    }
    
    const port = prompt("Enter port number (e.g., 8080):");
    if (!port || isNaN(port) || port <= 0 || port > 65535) {
        log('❌ Valid port number is required (1-65535)');
        return;
    }
    
    const username = prompt("Enter username:");
    if (!username) {
        log('❌ Username is required');
        return;
    }
    
    const password = prompt("Enter password:");
    if (!password) {
        log('❌ Password is required');
        return;
    }
    
    try {
        // Create payload in format: URL<.,.>port<.,.>username<.,.>password
        const delimiter = '<.,.>';
        const configString = `${url}${delimiter}${port}${delimiter}${username}${delimiter}${password}`;
        const configBytes = Array.from(new TextEncoder().encode(configString));
        
        // Add sub-command byte (0x0C = 12 for XID config write)
        const fullPayload = [0x0C, ...configBytes];
        
        const command = createCommandMessage(0x80, fullPayload);
        window.currentCommand = 'Write Configuration';
        
        log('📤 Sending Write Configuration...');
        log('⚠️  WARNING: Modifying device server credentials!');
        log(`📋 Config: URL=${url}, Port=${port}, User=${username}, Pass=${'*'.repeat(password.length)}`);
        log(`📋 Frame: ${formatBytes(command)}`);
        
        const writeChars = Object.values(characteristics).filter(char => 
            char.properties.write || char.properties.writeWithoutResponse
        );
        
        if (writeChars.length === 0) {
            log('❌ No writable characteristics found');
            return;
        }
        
        const writeChar = writeChars[0];
        await writeChar.writeValueWithoutResponse(command);
        log('✅ Configuration write command sent successfully');
        
    } catch (error) {
        log(`❌ Failed to send Write Configuration: ${error.message}`);
    }
}

// ========================================
// BROWSER COMPATIBILITY CHECK
// ========================================

// Check browser compatibility
if (!navigator.bluetooth) {
    log('❌ Web Bluetooth not supported');
}

// Export functions for global access
if (typeof window !== 'undefined') {
    // Connection functions
    window.connect = connect;
    window.disconnect = disconnect;
    window.disconnectAll = disconnectAll;
    
    // Command sending functions
    window.sendCommand = sendCommand;
    window.sendMeterIPCommand = sendMeterIPCommand;
    window.sendConfigWriteCommand = sendConfigWriteCommand;
    
    // Utility functions
    window.formatBytes = formatBytes;
    window.createCommandMessage = createCommandMessage;
    
    // OTA functions
    window.handleFirmwareFile = handleFirmwareFile;
    window.performOTAUpdate = performOTAUpdate;
    
    // Test functions
    window.runAllTests = runAllTests;
    window.setCurrentDateTime = setCurrentDateTime;
    window.setLocalApiPort = setLocalApiPort;
}