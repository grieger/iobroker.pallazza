/* jshint -W097 */// jshint strict:false
/*jslint node: true */
/*jshint esversion: 6 */
'use strict';

// Dependencies
const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const md5 = require('md5');
const request = require('request');
const util = require('util');

// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.haassohn.0

// Variables
const deviceStates = [];              // Used to internally buffer the retrieved states before writing them to the adapter
let noOfConnectionErrors = 0;         // Counter for connection problems
let missingState = false;             // If a device state cannot be mapped to an internal state of the adapter, this variable gets set
let timer;                            // Settimeout-Pointer to the poll-function
let disableAdapter = false;           // If an error occurs, this variable is set to true which disables the adapter
let hw_version;                       // Hardware version retrieved from the device
let sw_version;                       // Software version retrieved from the device
let hpin;                             // HPIN is the 'encrypted' PIN of the device
let hspin;                            // HSPIN is the secret, depending on the current NONCE and the HPIN
let nonce;                            // The current NONCE of the device
let nonceTimestamp = 0;               // Timestamp when the nonce was last updated
const nonceExpiryTime = 60 * 60 * 1000; // Example: 1 hour in milliseconds
let adapter;                          // Adapter object

// Promisify adapter methods for async/await
const getObjectAsync = util.promisify;
const getStateAsync = util.promisify;
const setStateAsync = util.promisify;

// Start Adapter function
function startAdapter(options) {
    options = options || {};

    Object.assign(options, {
        name: 'haassohn',

        // is called when databases are connected and adapter received configuration.
        // start here!
        ready: () => {
            initialize();
        },

        // is called when adapter shuts down - callback has to be called under any circumstances!
        unload: callback => {
            terminate(callback);
        },

        // is called if a subscribed state changes
        stateChange: (id, state) => {
            handleStateChange(id, state);
        }
    });

    adapter = new utils.Adapter(options);

    return adapter;
}

// Initialization
async function initialize() {
    // All states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');

    // Calculate HPIN
    hpin = calculateHPIN(adapter.config.pin);

    // Start polling
    await pollDeviceStatus();
}

// Cleanup and terminate the adapter
function terminate(callback) {
    try {
        adapter.log.info('Adapter is shutting down. Cleaning everything up');

        // Clear timer
        clearTimeout(timer);

        adapter.log.debug('Adapter was shut down. Cleaned everything up.');
        callback();
    } catch (e) {
        callback();
    }
}

// Handle a state change
async function handleStateChange(id, state) {
    // Warning, state can be null if it was deleted
    adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

    // you can use the ack flag to detect if it is status (true) or command (false)
    if (state && !state.ack) {
        adapter.log.debug('stateChange (command): ' + id + ' ' + JSON.stringify(state));

        if (String(id) === (adapter.namespace + '.device.prg')) {
            // Set new program
            const post_data_prg = '{"prg":' + state.val + '}';

            // Perform request
            makeAuthenticatedRequest({
                method: 'POST',
                headers: createHeader(post_data_prg),
                url: 'http://' + adapter.config.fireplaceAddress + '/status.cgi',
                body: post_data_prg
            }, async function (error, response, body) {
                adapter.log.debug('POST response: ' + response + ' [RESPONSE]; ' + body + ' [BODY]; ' + error + ' [ERROR];');

                // POST was successful, perform ack
                if (error === null && response.statusCode === 200) {
                    // Acknowledge command
                    await adapter.setStateAsync(adapter.namespace + '.device.prg', state.val, true);
                // POST was not successful, revert
                } else {
                    adapter.log.error('stateChange (command): ' + id + ' ' + JSON.stringify(state) + ' was not successful');
                    adapter.log.error('POST response: ' + response + ' [RESPONSE]; ' + body + ' [BODY]; ' + error + ' [ERROR];');
                }

                // Poll new state to update nonce immediately
                await pollDeviceStatus();
            });
        } else if (String(id) === (adapter.namespace + '.device.sp_temp')) {
            // Set new target temperature
            const post_data_sp_temp = '{"sp_temp":' + state.val + '}';

            // Perform request
            makeAuthenticatedRequest({
                method: 'POST',
                headers: createHeader(post_data_sp_temp),
                url: 'http://' + adapter.config.fireplaceAddress + '/status.cgi',
                body: post_data_sp_temp
            }, async function (error, response, body) {
                adapter.log.debug('POST response: ' + response + ' [RESPONSE]; ' + body + ' [BODY]; ' + error + ' [ERROR];');

                // POST was successful, perform ack
                if (error === null && response.statusCode === 200) {
                    // Acknowledge command
                    await adapter.setStateAsync(adapter.namespace + '.device.sp_temp', state.val, true);
                // POST was not successful, revert
                } else {
                    adapter.log.error('stateChange (command): ' + id + ' ' + JSON.stringify(state) + ' was not successful');
                    adapter.log.error('POST response: ' + response + ' [RESPONSE]; ' + body + ' [BODY]; ' + error + ' [ERROR];');
                }

                // Poll new state to update nonce immediately
                await pollDeviceStatus();
            });
        } else if (String(id) === (adapter.namespace + '.device.eco_mode')) {
            // Check if eco mode is editable before sending command
            try {
                const ecoEditableState = await adapter.getStateAsync('device.meta.eco_editable');
                if (ecoEditableState && ecoEditableState.val) {
                    // Eco mode is editable, proceed with setting new eco mode
                    const post_data_eco_mode = '{"eco_mode":' + state.val + '}';

                    // Perform request
                    makeAuthenticatedRequest({
                        method: 'POST',
                        headers: createHeader(post_data_eco_mode),
                        url: 'http://' + adapter.config.fireplaceAddress + '/status.cgi',
                        body: post_data_eco_mode
                    }, async function (error, response, body) {
                        adapter.log.debug('POST response: ' + response + ' [RESPONSE]; ' + body + ' [BODY]; ' + error + ' [ERROR];');

                        // POST was successful, perform ack
                        if (error === null && response.statusCode === 200) {
                            // Acknowledge command
                            await adapter.setStateAsync(adapter.namespace + '.device.eco_mode', state.val, true);
                        // POST was not successful, revert
                        } else {
                            adapter.log.error('stateChange (command): ' + id + ' ' + JSON.stringify(state) + ' was not successful');
                            adapter.log.error('POST response: ' + response + ' [RESPONSE]; ' + body + ' [BODY]; ' + error + ' [ERROR];');
                        }

                        // Poll new state to update nonce immediately
                        await pollDeviceStatus();
                    });
                } else {
                    // Eco mode is not editable, log and ignore the command
                    adapter.log.warn('Eco mode is not editable. Ignoring command to change eco mode.');
                }
            } catch (err) {
                adapter.log.error('Error getting eco_editable state: ' + err);
            }
        }
    }
}

// Main function to poll the device status
async function pollDeviceStatus() {
    adapter.log.debug('Polling device started');
    clearTimeout(timer);

    // Calculate device link
    const link = 'http://' + adapter.config.fireplaceAddress + '/status.cgi';

    try {
        // Promisify request for async/await
        const response = await util.promisify(request)(link);
        if (response && response.statusCode === 200) {
            adapter.log.debug('Received successful response from device');
            adapter.log.debug('Response body: ' + response.body);

            let result;
            try {
                // Evaluate result
                result = JSON.parse(response.body);

                // Reset error counter
                noOfConnectionErrors = 0;

                // Update nonce and hspin if present
                if (result.device && result.device.meta && result.device.meta.nonce) {
                    adapter.log.debug(`Old nonce: ${nonce}, New nonce: ${result.device.meta.nonce}`);
                    if (nonce !== result.device.meta.nonce) {
                        nonce = result.device.meta.nonce;
                        nonceTimestamp = Date.now();
                        hspin = calculateHSPIN(nonce, hpin);
                        adapter.log.debug(`Updated nonce to: ${nonce} and hspin to: ${hspin}`);
                    }
                } else {
                    adapter.log.warn('Nonce not found in the response');
                }

                // Sync states
                await syncState(result, '');
            } catch (e) {
                // Parser error
                adapter.log.error('Error parsing the response: ' + e);
                noOfConnectionErrors++;
            }
        } else {
            // Connection error
            adapter.log.error('Error retrieving status: ' + (response ? response.statusCode : 'No response'));
            noOfConnectionErrors++;
        }
    } catch (error) {
        adapter.log.error('Error retrieving status: ' + error);
        noOfConnectionErrors++;
    }

    // Update connection status
    updateConnectionStatus();

    // Poll again, except a critical error occurred
    if (!disableAdapter) {
        timer = setTimeout(pollDeviceStatus, adapter.config.pollingInterval * 1000);
    }

    adapter.log.debug('Polling device ended');
}

// Indicate the state of the connection by setting the state 'connected'
function updateConnectionStatus() {
    // Check if there were retries
    if (noOfConnectionErrors > 0) {
        adapter.log.error('There was an error getting the device status (counter: ' + noOfConnectionErrors + ')');
    }

    // Query current connection indicator to check whether something changed at all
    adapter.getState('info.connection', function (err, state) {
        const connectionSuccessful = noOfConnectionErrors === 0;

        // Check whether the adapter shall be disabled
        if (disableAdapter) {
            // Update state
            adapter.setState('info.connection', false, true);
        // Check whether the state has changed. If so, change state
        } else if (state === null || state.val !== connectionSuccessful) {
            // Update state
            adapter.setState('info.connection', connectionSuccessful, true);
        }
    });

    // Query current missing-state indicator to check whether something changed at all
    adapter.getState('info.missing_state', function (err, state) {
        // Check whether the state has changed. If so, change state
        if (state === null || state.val !== missingState) {
            // Update state
            adapter.setState('info.missing_state', missingState, true);
        }
    });

    // Check if hardware / software combination is supported
    if (hw_version !== undefined && sw_version !== undefined) {
        adapter.log.debug('Validating Hardware / Software combination. Supported: ' + Object.getOwnPropertyNames(adapter.config.supportedHwSwVersions));

        try {
            if (!adapter.config.supportedHwSwVersions[hw_version + '_' + sw_version]) {
                adapter.log.debug('Hardware / Software combination is NOT supported by this adapter!');
                adapter.log.error('Hardware / Software combination (' + hw_version + '_' + sw_version + ') is not supported by this adapter! Please open an issue on GitHub.');
                disableAdapter = true;
            } else {
                adapter.log.debug('Hardware / Software combination is supported by this adapter!');
            }

        } catch (err) {
            // Dump error and stop adapter
            adapter.log.error(err);
            disableAdapter = true;
        }
    }

    // Query current state to check whether something changed at all
    adapter.getState('info.terminated', function (err, state) {
        // Check whether the state has changed. If so, change state
        if (state === null || state.val !== disableAdapter) {
            // Update state
            adapter.setState('info.terminated', disableAdapter, true);
        }

        // Shall we disable the adapter?
        if (disableAdapter) {
            adapter.log.error('Some critical error occurred (see log). Disabling the adapter');
        }
    });
}

// Synchronize the retrieved states with the states of the adapter
async function syncState(state, path) {
    adapter.log.debug('Syncing state of the device');

    try {
        for (const key of Object.keys(state)) {
            // If value is an object: recurse
            if (typeof state[key] === 'object' && !Array.isArray(state[key])) {
                const newPath = path === '' ? key : path + '.' + key;
                await syncState(state[key], newPath);
            // If value is atomic: process state
            } else {
                // Calculate stateName
                const stateName = path === '' ? 'device.' + key : 'device.' + path + '.' + key;
                const value = state[key];

                adapter.log.debug(`Processing state: ${stateName} with value: ${value}`);

                // Store retrieved state in central data structure
                const newState = { value };
                deviceStates[stateName] = newState;

                try {
                    const object = await adapter.getObjectAsync(stateName);
                    if (object !== null) {
                        const currentState = await adapter.getStateAsync(stateName);
                        const newStateData = deviceStates[stateName];
                        deviceStates[stateName] = null;

                        let newValue;
                        if (typeof newStateData.value === 'object') {
                            newValue = JSON.stringify(newStateData.value);
                        } else {
                            newValue = newStateData.value;
                        }

                        // Special handling for meta.nonce
                        if (stateName === 'device.meta.nonce') {
                            adapter.log.debug(`Old nonce: ${nonce}, New nonce: ${newValue}`);
                            if (nonce !== newValue) {
                                nonce = newValue;
                                nonceTimestamp = Date.now();
                                hspin = calculateHSPIN(nonce, hpin);
                                adapter.log.debug(`Updated nonce to: ${nonce} and hspin to: ${hspin}`);
                            }
                        }

                        // Buffer HW-Version for supported version check
                        if (stateName === 'device.meta.hw_version' && hw_version !== newValue) {
                            hw_version = newValue;
                        // Buffer SW-Version for supported version check
                        } else if (stateName === 'device.meta.sw_version' && sw_version !== newValue) {
                            sw_version = newValue;
                        // Buffer nonce to calculate HSPIN
                        } else if (stateName === 'device.meta.nonce' && nonce !== newValue) {
                            nonce = newValue;
                            nonceTimestamp = Date.now();
                            hspin = calculateHSPIN(nonce, hpin);
                        }

                        // Check whether the state has changed. If so, change state
                        if (currentState !== null) {
                            if (currentState.val !== newValue) {
                                adapter.log.debug(`State changed for ${stateName}: ${newValue} (was: ${currentState.val})`);
                                await adapter.setStateAsync(stateName, newValue, true);
                            }
                        } else {
                            adapter.log.debug(`Initial setting of state ${stateName} to ${newValue}`);
                            await adapter.setStateAsync(stateName, newValue, true);
                        }
                    } else {
                        adapter.log.warn(`State ${stateName} does not exist. Please open an issue on GitHub.`);
                        // Indicate that state is missing
                        missingState = true;
                    }

                    // Special handling for eco_editable
                    if (stateName === 'device.meta.eco_editable') {
                        const obj = await adapter.getObjectAsync('device.eco_mode');
                        if (obj) {
                            obj.common.write = value;
                            await adapter.setObjectAsync('device.eco_mode', obj);
                        }
                    }
                } catch (err) {
                    adapter.log.error(`Error processing state ${stateName}: ${err}`);
                    disableAdapter = true;
                }
            }
        }
    } catch (e) {
        // Dump error and stop adapter
        adapter.log.error('Error syncing states: ' + e);
        disableAdapter = true;
    }
}


// Given the HPIN and the current NONCE, the HSPIN is calculated
// HSPIN = MD5(NONCE + HPIN)
function calculateHSPIN(NONCE, HPIN) {
    const result = md5(NONCE + HPIN);
    adapter.log.debug(`Calculated HSPIN with NONCE: ${NONCE} and HPIN: ${hpin} => HSPIN: ${result}`);
    return result;
}

// The PIN of the device is used to calculate the HPIN
// HPIN = MD5(PIN)
function calculateHPIN(PIN) {
    const result = md5(PIN);
    adapter.log.debug(`Calculated HPIN from PIN: ${PIN} => HPIN: ${result}`);
    return result;
}

// Provides a header for a POST request
function createHeader(post_data) {
    return {
        'Host': adapter.config.fireplaceAddress,
        'Accept': '*/*',
        'Proxy-Connection': 'keep-alive',
        'X-BACKEND-IP': 'https://app.haassohn.com',
        'Accept-Language': 'de-DE;q=1.0, en-DE;q=0.9',
        'Accept-Encoding': 'gzip;q=1.0, compress;q=0.5',
        'token': '32bytes',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(post_data),
        'User-Agent': 'ios',
        'Connection': 'keep-alive',
        'X-HS-PIN': hspin
    };
}

// Centralized authenticated request to ensure nonce is up-to-date
function makeAuthenticatedRequest(options, callback) {
    // Validate and refresh nonce before making the request
    validateAndRefreshNonce(async () => {
        // Update headers with the latest hspin
        options.headers = createHeader(options.body);
        request(options, callback);
    });
}

// Validate nonce and refresh if necessary
function validateAndRefreshNonce(callback) {
    const currentTime = Date.now();
    if (!nonce || (currentTime - nonceTimestamp) > nonceExpiryTime) {
        adapter.log.debug('Nonce is missing or expired. Polling device to refresh nonce.');
        pollDeviceStatus().then(() => {
            callback();
        }).catch(err => {
            adapter.log.error('Error refreshing nonce: ' + err);
            callback();
        });
    } else {
        adapter.log.debug('Nonce is valid. Proceeding with request.');
        callback();
    }
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
