plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// FCM needs app/google-services.json from the Firebase console (see README). The build still works without
// it so location + UI can be tried first; push just stays off until the file is there.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
} else {
    logger.warn("apps/android/app/google-services.json missing: building without Firebase (no push). See apps/android/README.md")
}

android {
    namespace = "com.malcolmocean.opportune"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.malcolmocean.opportune"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // Fused location + activity recognition
    implementation("com.google.android.gms:play-services-location:21.0.1")

    // Push
    implementation(platform("com.google.firebase:firebase-bom:32.7.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")
}
