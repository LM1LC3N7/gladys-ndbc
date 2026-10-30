// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect()
// and delegates to the NdbcApp (src/app.js). Read-only: the NDBC files are
// public data, nothing is ever commanded.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { NdbcApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';

const gladys = new GladysIntegration();
const app = new NdbcApp({ gladys, logger });

// --- Discovery: the stations of the configuration, never a read ----------------
gladys.onScanRequest(() => app.scan());

// --- Configuration screen button ------------------------------------------------
// What the last read of each station gave and when the next comes; it never reads.
gladys.onAction(ACTIONS.TEST, () => app.testConnection());

// --- A device created: its values under 2 h old, from the last read ------------
gladys.onDeviceCreated((device) => app.deviceCreated(device));

// --- Configuration changed by the user ------------------------------------------
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated');
  return app.start(config);
});

// --- Connection lifecycle --------------------------------------------------------
// Every connection reads the configuration (retried forever when Gladys fails
// to give it) and restarts; a reconnection never reads NDBC sooner than the
// interval (the time of the last attempt is in /data).
gladys.on('connected', () => {
  app.connected().catch((err) => logger.error(`Start failed (${err?.name ?? 'Error'})`));
});
gladys.on('disconnected', () => {
  app.disconnected().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
});
gladys.handleShutdown(() => app.stop());

logger.info('Starting the NDBC integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
