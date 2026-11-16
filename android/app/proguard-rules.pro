# Keep application classes and data models
-keep class ua.blackout.prewarning.** { *; }
-keep class ua.blackout.prewarning.data.model.** { *; }

# Keep Glance app widget
-keep class ua.blackout.prewarning.widget.** { *; }

# Keep WorkManager worker
-keep class ua.blackout.prewarning.worker.** { *; }

# Keep BroadcastReceivers and Notifications
-keep class ua.blackout.prewarning.receiver.** { *; }
-keep class ua.blackout.prewarning.notification.** { *; }

# Ignore compile-time nullability annotations of libraries in R8
-dontwarn org.jspecify.annotations.**
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animal_sniffer.**
-ignorewarnings
