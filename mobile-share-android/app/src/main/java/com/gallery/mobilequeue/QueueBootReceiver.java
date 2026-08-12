package com.gallery.mobilequeue;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores the notification and resumes any durable pending queue after reboot/update. */
public class QueueBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        QueueNotification.refresh(context);
        if (PendingQueueStore.size(context) > 0) {
            QueueWork.enqueueNow(context);
        }
    }
}
