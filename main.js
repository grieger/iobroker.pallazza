/* jshint -W097 */ // jshint strict:false
/*jslint node: true */
/*jshint esversion: 6 */
"use strict";

// Dependencies
const utils = require("@iobroker/adapter-core"); // Get common adapter utils
const md5 = require("md5");
const axios = require("axios"); // Use axios for HTTP requests

// Variables
const deviceStates = {}; // Used to internally buffer the retrieved states before writing them to the adapter
let noOfConnectionErrors = 0; // Counter for connection problems
let missingState = false; // If a device state cannot be mapped to an internal state of the adapter, this variable gets set
let timer; // Settimeout-Pointer to the poll-function
let disableAdapter = false; // If an error occurs, this variable is set to true which disables the adapter
let hw_version; // Hardware version retrieved from the device
let sw_version; // Software version retrieved from the device
let hpin; // HPIN is the 'encrypted' PIN of the device
let hspin; // HSPIN is the secret, depending on the current NONCE and the HPIN
let nonce; // The current NONCE of the device
let nonceTimestamp = 0; // Timestamp when the nonce was last updated
const nonceExpiryTime = 60 * 60 * 1000; // Example: 1 hour in milliseconds
let adapterInstance; // Adapter object

// Start Adapter function
function startAdapter(options) {
  options = options || {};

  Object.assign(options, {
    name: "haassohn",

    // is called when databases are connected and adapter received configuration.
    // start here!
    ready: () => {
      initialize();
    },

    // is called when adapter shuts down - callback has to be called under any circumstances!
    unload: (callback) => {
      terminate(callback);
    },

    // is called if a subscribed state changes
    stateChange: (id, state) => {
      handleStateChange(id, state);
    },
  });

  adapterInstance = new utils.Adapter(options);

  return adapterInstance;
}

// Initialization
async function initialize() {
  // All states changes inside the adapters namespace are subscribed
  adapterInstance.subscribeStates("*");

  // Calculate HPIN
  hpin = calculateHPIN(adapterInstance.config.pin);

  // Start polling
  await pollDeviceStatus();
}

// Cleanup and terminate the adapter
function terminate(callback) {
  try {
    adapterInstance.log.info("Adapter is shutting down. Cleaning everything up");

    // Clear timer
    clearTimeout(timer);

    adapterInstance.log.debug("Adapter was shut down. Cleaned everything up.");
    callback();
  } catch (e) {
    callback();
  }
}

// Handle a state change
async function handleStateChange(id, state) {
  // Warning, state can be null if it was deleted
  adapterInstance.log.debug("stateChange " + id + " " + JSON.stringify(state));

  // you can use the ack flag to detect if it is status (true) or command (false)
  if (state && !state.ack) {
    adapterInstance.log.debug("stateChange (command): " + id + " " + JSON.stringify(state));

    let post_data;
    let stateToAcknowledge;

    if (String(id) === adapterInstance.namespace + ".device.prg") {
      // Set new program
      post_data = { prg: state.val };
      stateToAcknowledge = "device.prg";
    } else if (String(id) === adapterInstance.namespace + ".device.sp_temp") {
      // Set new target temperature
      post_data = { sp_temp: state.val };
      stateToAcknowledge = "device.sp_temp";
    } else if (String(id) === adapterInstance.namespace + ".device.eco_mode") {
      // Check if eco mode is editable before sending command
      try {
        const ecoEditableState = await adapterInstance.getStateAsync("device.meta.eco_editable");
        if (ecoEditableState && ecoEditableState.val) {
          // Eco mode is editable, proceed with setting new eco mode
          post_data = { eco_mode: state.val };
          stateToAcknowledge = "device.eco_mode";
        } else {
          // Eco mode is not editable, log and ignore the command
          adapterInstance.log.warn("Eco mode is not editable. Ignoring command to change eco mode.");
          return;
        }
      } catch (err) {
        adapterInstance.log.error("Error getting eco_editable state: " + err);
        return;
      }
    } else {
      adapterInstance.log.warn(`Unhandled state change for ${id}`);
      return;
    }

    try {
      const response = await makeAuthenticatedRequest({
        method: "POST",
        url: "http://" + adapterInstance.config.fireplaceAddress + "/status.cgi",
        data: post_data,
        headers: createHeader(JSON.stringify(post_data)),
      });

      adapterInstance.log.debug(`POST response: ${response.status} [STATUS]; ${JSON.stringify(response.data)} [BODY]`);

      if (response.status === 200) {
        // Acknowledge command
        await adapterInstance.setStateAsync(`${adapterInstance.namespace}.${stateToAcknowledge}`, state.val, true);
      } else {
        adapterInstance.log.error(`stateChange (command): ${id} ${JSON.stringify(state)} was not successful`);
      }
    } catch (error) {
      adapterInstance.log.error(`Error executing stateChange (command): ${error}`);
    }

    // Poll new state to update nonce immediately
    await pollDeviceStatus();
  }
}

// Main function to poll the device status
async function pollDeviceStatus() {
  adapterInstance.log.debug("Polling device started");
  clearTimeout(timer);

  // Calculate device link with unique query parameter to prevent caching
  const link = "http://" + adapterInstance.config.fireplaceAddress + "/status.cgi?ts=" + Date.now();

  const options = {
    method: "GET",
    url: link,
    headers: {
      Connection: "close",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
    timeout: 5000, // optional: set a timeout
  };

  try {
    const response = await axios(options);

    if (response.status === 200) {
      adapterInstance.log.debug("Received successful response from device");
      adapterInstance.log.debug("Response body: " + JSON.stringify(response.data));

      let result = response.data;

      // Reset error counter
      noOfConnectionErrors = 0;

      // Update nonce and hspin if present
      if (result.meta && result.meta.nonce) {
        adapterInstance.log.debug(`Old nonce: ${nonce}, New nonce: ${result.meta.nonce}`);
        if (nonce !== result.meta.nonce) {
          nonce = result.meta.nonce;
          nonceTimestamp = Date.now();
          hspin = calculateHSPIN(nonce, hpin);
          adapterInstance.log.debug(`Updated nonce to: ${nonce} and hspin to: ${hspin}`);
        } else {
          adapterInstance.log.debug(`Nonce remains unchanged: ${nonce}`);
        }
      } else {
        adapterInstance.log.warn("Nonce not found in the response");
      }

      // Sync states
      await syncState(result, "");
    } else {
      // Connection error
      adapterInstance.log.error("Error retrieving status: " + response.status);
      noOfConnectionErrors++;
    }
  } catch (error) {
    adapterInstance.log.error("Error retrieving status: " + error);
    noOfConnectionErrors++;
  }

  // Update connection status
  updateConnectionStatus();

  // Poll again, except a critical error occurred
  if (!disableAdapter) {
    timer = setTimeout(pollDeviceStatus, adapterInstance.config.pollingInterval * 1000);
  }

  adapterInstance.log.debug("Polling device ended");
}

// Indicate the state of the connection by setting the state 'connected'
function updateConnectionStatus() {
  // Check if there were retries
  if (noOfConnectionErrors > 0) {
    adapterInstance.log.error("There was an error getting the device status (counter: " + noOfConnectionErrors + ")");
  }

  // Query current connection indicator to check whether something changed at all
  adapterInstance.getState("info.connection", function (err, state) {
    const connectionSuccessful = noOfConnectionErrors === 0;

    // Check whether the adapter shall be disabled
    if (disableAdapter) {
      // Update state
      adapterInstance.setState("info.connection", false, true);
      // Check whether the state has changed. If so, change state
    } else if (state === null || state.val !== connectionSuccessful) {
      // Update state
      adapterInstance.setState("info.connection", connectionSuccessful, true);
    }
  });

  // Query current missing-state indicator to check whether something changed at all
  adapterInstance.getState("info.missing_state", function (err, state) {
    // Check whether the state has changed. If so, change state
    if (state === null || state.val !== missingState) {
      // Update state
      adapterInstance.setState("info.missing_state", missingState, true);
    }
  });

  // Check if hardware / software combination is supported
  if (hw_version !== undefined && sw_version !== undefined) {
    adapterInstance.log.debug("Validating Hardware / Software combination. Supported: " + Object.keys(adapterInstance.config.supportedHwSwVersions));

    try {
      if (!adapterInstance.config.supportedHwSwVersions[`${hw_version}_${sw_version}`]) {
        adapterInstance.log.debug("Hardware / Software combination is NOT supported by this adapter!");
        adapterInstance.log.error("Hardware / Software combination (" + hw_version + "_" + sw_version + ") is not supported by this adapter! Please open an issue on GitHub.");
        disableAdapter = true;
      } else {
        adapterInstance.log.debug("Hardware / Software combination is supported by this adapter!");
      }
    } catch (err) {
      // Dump error and stop adapter
      adapterInstance.log.error(err);
      disableAdapter = true;
    }
  }

  // Query current state to check whether something changed at all
  adapterInstance.getState("info.terminated", function (err, state) {
    // Check whether the state has changed. If so, change state
    if (state === null || state.val !== disableAdapter) {
      // Update state
      adapterInstance.setState("info.terminated", disableAdapter, true);
    }

    // Shall we disable the adapter?
    if (disableAdapter) {
      adapterInstance.log.error("Some critical error occurred (see log). Disabling the adapter");
    }
  });
}

// Synchronize the retrieved states with the states of the adapter
async function syncState(state, path) {
  adapterInstance.log.debug("Syncing state of the device");

  try {
    for (const key of Object.keys(state)) {
      // If value is an object: recurse
      if (typeof state[key] === "object" && !Array.isArray(state[key])) {
        const newPath = path === "" ? key : path + "." + key;
        await syncState(state[key], newPath);
      }
      // If value is atomic or an array: process state
      else {
        // Calculate stateName
        const stateName = path === "" ? "device." + key : "device." + path + "." + key;
        const value = state[key];

        adapterInstance.log.debug(`Processing state: ${stateName} with value: ${value}`);

        // Store retrieved state in central data structure
        const newState = { value };
        deviceStates[stateName] = newState;

        try {
          const object = await adapterInstance.getObjectAsync(stateName);
          if (object !== null) {
            const currentState = await adapterInstance.getStateAsync(stateName);
            const newStateData = deviceStates[stateName];
            deviceStates[stateName] = null;

            let newValue;
            if (typeof newStateData.value === "object") {
              newValue = JSON.stringify(newStateData.value);
            } else {
              newValue = newStateData.value;
            }

            // Special handling for meta.nonce
            if (stateName === "device.meta.nonce") {
              adapterInstance.log.debug(`Old nonce: ${nonce}, New nonce: ${newValue}`);
              if (nonce !== newValue) {
                nonce = newValue;
                nonceTimestamp = Date.now();
                hspin = calculateHSPIN(nonce, hpin);
                adapterInstance.log.debug(`Updated nonce to: ${nonce} and hspin to: ${hspin}`);
              }
            }

            // Buffer HW-Version for supported version check
            if (stateName === "device.meta.hw_version" && hw_version !== newValue) {
              hw_version = newValue;
            }
            // Buffer SW-Version for supported version check
            else if (stateName === "device.meta.sw_version" && sw_version !== newValue) {
              sw_version = newValue;
            }

            // Check whether the state has changed. If so, change state
            if (currentState !== null) {
              if (currentState.val !== newValue) {
                adapterInstance.log.debug(`State changed for ${stateName}: ${newValue} (was: ${currentState.val})`);
                await adapterInstance.setStateAsync(stateName, newValue, true);
              }
            } else {
              adapterInstance.log.debug(`Initial setting of state ${stateName} to ${newValue}`);
              await adapterInstance.setStateAsync(stateName, newValue, true);
            }
          } else {
            adapterInstance.log.warn(`State ${stateName} does not exist. Please open an issue on GitHub.`);
            // Indicate that state is missing
            missingState = true;
          }

          // Special handling for eco_editable
          if (stateName === "device.meta.eco_editable") {
            const obj = await adapterInstance.getObjectAsync("device.eco_mode");
            if (obj) {
              obj.common.write = value;
              await adapterInstance.setObjectAsync("device.eco_mode", obj);
            }
          }
        } catch (err) {
          adapterInstance.log.error(`Error processing state ${stateName}: ${err}`);
          disableAdapter = true;
        }
      }
    }
  } catch (e) {
    // Dump error and stop adapter
    adapterInstance.log.error("Error syncing states: " + e);
    disableAdapter = true;
  }
}

// Given the HPIN and the current NONCE, the HSPIN is calculated
// HSPIN = MD5(NONCE + HPIN)
function calculateHSPIN(NONCE, HPIN) {
  const result = md5(NONCE + HPIN);
  adapterInstance.log.debug(`Calculated HSPIN with NONCE: ${NONCE} and HPIN: ${hpin} => HSPIN: ${result}`);
  return result;
}

// The PIN of the device is used to calculate the HPIN
// HPIN = MD5(PIN)
function calculateHPIN(PIN) {
  const result = md5(PIN);
  adapterInstance.log.debug(`Calculated HPIN from PIN: ${PIN} => HPIN: ${result}`);
  return result;
}

// Provides a header for a POST request
function createHeader(post_data) {
  return {
    Host: adapterInstance.config.fireplaceAddress,
    Accept: "*/*",
    "Proxy-Connection": "keep-alive",
    "X-BACKEND-IP": "https://app.haassohn.com",
    "Accept-Language": "de-DE;q=1.0, en-DE;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    token: "32bytes",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(post_data),
    "User-Agent": "ios",
    Connection: "keep-alive",
    "X-HS-PIN": hspin,
  };
}

// Centralized authenticated request to ensure nonce is up-to-date
async function makeAuthenticatedRequest(options) {
  // Validate and refresh nonce before making the request
  await validateAndRefreshNonce();

  // Update headers with the latest hspin
  options.headers = createHeader(options.data);

  try {
    const response = await axios(options);
    return response;
  } catch (error) {
    throw error;
  }
}

// Validate nonce and refresh if necessary
async function validateAndRefreshNonce() {
  const currentTime = Date.now();
  if (!nonce || currentTime - nonceTimestamp > nonceExpiryTime) {
    adapterInstance.log.debug("Nonce is missing or expired. Polling device to refresh nonce.");
    await pollDeviceStatus();
  } else {
    adapterInstance.log.debug("Nonce is valid. Proceeding with request.");
  }
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
  module.exports = startAdapter;
} else {
  // or start the instance directly
  startAdapter();
}
