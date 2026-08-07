plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tesis.dronepatrol"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tesis.dronepatrol"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    // mock: dron simulado, corre en cualquier dispositivo/emulador sin hardware.
    // dji : integración real con DJI MSDK v5 (requiere API key y probar con el dron).
    flavorDimensions += "drone"
    productFlavors {
        create("mock") { dimension = "drone" }
        create("dji") {
            dimension = "drone"
            manifestPlaceholders["DJI_API_KEY"] = (project.findProperty("DJI_API_KEY") ?: "") as String
        }
    }

    buildFeatures { viewBinding = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        // El MSDK de DJI trae librerías nativas que pueden duplicar estos archivos
        resources.pickFirsts += listOf("META-INF/rxjava.properties")
        // El SDK requiere extraer sus librerías nativas al instalar
        jniLibs.useLegacyPackaging = true
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // DJI Mobile SDK v5 — solo para el flavor "dji" (publicado en Maven Central).
    // Nota: el Mini 4 Pro está soportado por MSDK v5; las misiones de waypoints
    // nativas NO (solo Enterprise), por eso el patrullaje usa Virtual Stick.
    "djiImplementation"("com.dji:dji-sdk-v5-aircraft:5.15.0")
    "djiCompileOnly"("com.dji:dji-sdk-v5-aircraft-provided:5.15.0")
    "djiRuntimeOnly"("com.dji:dji-sdk-v5-networkImp:5.15.0")
}
