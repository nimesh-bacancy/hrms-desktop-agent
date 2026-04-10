import { autoUpdater } from 'electron-updater';
import { dialog, Notification } from 'electron';
import log from 'electron-log';

// Configure logging for updates
autoUpdater.logger = log;
// @ts-ignore
autoUpdater.logger.transports.file.level = 'info';

export function initializeUpdater() {
  // Check for updates on startup
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-available', () => {
    console.log('Update available. Downloading...');
  });

  autoUpdater.on('update-downloaded', (info) => {
    // Show a native notification when update is ready
    if (Notification.isSupported()) {
      const notify = new Notification({
        title: 'WorkPulse Update Ready',
        body: `Version ${info.version} has been downloaded and will be installed on restart.`,
        urgency: 'normal'
      });
      notify.show();
    }

    // Optionally prompt user to restart now
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `A new version (${info.version}) has been downloaded. Would you like to restart and install it now?`,
      buttons: ['Later', 'Restart Now']
    }).then((result) => {
      if (result.response === 1) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => {
    log.error('Error in auto-updater: ' + err);
  });
}
