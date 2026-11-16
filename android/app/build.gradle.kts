import java.util.Base64

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "ua.blackout.prewarning"
    compileSdk = 36

    defaultConfig {
        val appPkgEnv = System.getenv("ANDROID_APPLICATION_ID")?.trim()?.takeIf { it.isNotBlank() }
        applicationId = appPkgEnv ?: "ua.blackout.prewarning.poltava"
        minSdk = 26
        targetSdk = 36
        versionCode = (System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 300) + 300
        val semverEnv = System.getenv("APP_VERSION_NAME")?.removePrefix("v")?.trim()?.takeIf { it.matches(Regex("^[0-9]+\\.[0-9]+\\.[0-9]+.*")) }
        versionName = semverEnv ?: "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    val keystoreFile = file("keystore/debug.keystore")
    keystoreFile.parentFile?.mkdirs()
    val embeddedKeystoreBase64 = "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"
    keystoreFile.writeBytes(Base64.getDecoder().decode(embeddedKeystoreBase64))

    val uploadKeystorePath = System.getenv("UPLOAD_KEYSTORE_FILE")?.trim().orEmpty()
    val uploadKeystoreFile = if (uploadKeystorePath.isNotEmpty()) file(uploadKeystorePath) else file("keystore/upload-keystore.jks")
    val uploadStorePassword = System.getenv("UPLOAD_KEYSTORE_PASSWORD")?.trim()?.ifEmpty { null }
        ?: System.getenv("STORE_PASSWORD")?.trim().orEmpty()
    val uploadKeyAlias = System.getenv("UPLOAD_KEY_ALIAS")?.trim()?.ifEmpty { null }
        ?: System.getenv("KEY_ALIAS")?.trim()?.ifEmpty { null }
        ?: "upload"
    val uploadKeyPassword = System.getenv("UPLOAD_KEY_PASSWORD")?.trim()?.ifEmpty { null }
        ?: System.getenv("KEY_PASSWORD")?.trim()?.ifEmpty { null }
        ?: uploadStorePassword
    val hasUploadKeystore = uploadKeystoreFile.exists() && uploadStorePassword.isNotEmpty()

    signingConfigs {
        getByName("debug") {
            if (keystoreFile.exists()) {
                storeFile = keystoreFile
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
        create("upload") {
            if (hasUploadKeystore) {
                storeFile = uploadKeystoreFile
                storePassword = uploadStorePassword
                keyAlias = uploadKeyAlias
                keyPassword = uploadKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    buildTypes {
        release {
            isDebuggable = false
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (hasUploadKeystore) {
                signingConfigs.getByName("upload")
            } else {
                signingConfigs.getByName("debug")
            }
        }
        debug {
            // Keep identical applicationId ("ua.blackout.prewarning.poltava"), isDebuggable = false, and signingConfig so debug and release APKs can update each other in-place over v1.3.3 and preserve user settings
            isDebuggable = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // Core & Lifecycle
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)

    // Jetpack Compose & Material 3
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)

    // Android AppWidget (Jetpack Glance)
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.glance.material3)

    // Background Processing & Alarms
    implementation(libs.androidx.work.runtime.ktx)

    // Preferences & Local Storage
    implementation(libs.androidx.datastore.preferences)

    // HTML Parsing for ztoe.com.ua
    implementation(libs.jsoup)

    // Coroutines
    implementation(libs.kotlinx.coroutines.android)

    // Testing
    testImplementation(libs.junit)
    // JVM unit tests only get stubbed android.jar org.json; the real implementation is needed to read spec/vectors/*.json
    testImplementation("org.json:json:20240303")
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}