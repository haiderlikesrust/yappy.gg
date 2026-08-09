import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "gg.yappy.app"
  compileSdk = 35

  defaultConfig {
    applicationId = "gg.yappy.app"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "1.0.0"
    vectorDrawables { useSupportLibrary = true }
  }

  signingConfigs {
    /**
     * Reads android/keystore.properties if it exists (gitignored — a release
     * key must never be committed), otherwise falls back to the debug key so
     * `assembleRelease` still yields an installable APK for testing.
     *
     * The fallback is NOT for distribution: an APK's updates must be signed by
     * the same key forever, and the debug key is per-machine. Before handing
     * the APK to anyone, create the real key once and keep it safe:
     *
     *   keytool -genkeypair -v -keystore yappy-release.jks -alias yappy \
     *     -keyalg RSA -keysize 4096 -validity 10000
     *
     * then android/keystore.properties:
     *   storeFile=../yappy-release.jks
     *   storePassword=…
     *   keyAlias=yappy
     *   keyPassword=…
     */
    create("release") {
      val props = rootProject.file("keystore.properties")
      if (props.exists()) {
        val ks = Properties().apply { props.inputStream().use { load(it) } }
        storeFile = rootProject.file(ks.getProperty("storeFile"))
        storePassword = ks.getProperty("storePassword")
        keyAlias = ks.getProperty("keyAlias")
        keyPassword = ks.getProperty("keyPassword")
      } else {
        val debug = getByName("debug")
        storeFile = debug.storeFile
        storePassword = debug.storePassword
        keyAlias = debug.keyAlias
        keyPassword = debug.keyPassword
      }
    }
  }

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      // 10.0.2.2 is the host machine as seen from the Android emulator.
      // A physical device needs the LAN IP of the machine running the backend.
      buildConfigField("String", "API_URL", "\"http://10.0.2.2:3000/v1\"")
      buildConfigField("String", "GATEWAY_URL", "\"ws://10.0.2.2:3001\"")
      buildConfigField("String", "WEB_URL", "\"http://10.0.2.2:5173\"")
      // No local backup on the emulator; blank collapses to a single endpoint.
      buildConfigField("String", "API_URL_ALT", "\"\"")
      buildConfigField("String", "GATEWAY_URL_ALT", "\"\"")
    }
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      // These must match the deployed Caddy vhosts exactly. The gateway is
      // ws.yappy.gg — it was briefly written here as gateway.yappy.gg, a name
      // that never existed, which would have shipped an app that signs in
      // fine and then never receives a single realtime event.
      buildConfigField("String", "API_URL", "\"https://api.yappy.gg/v1\"")
      buildConfigField("String", "GATEWAY_URL", "\"wss://ws.yappy.gg\"")
      buildConfigField("String", "WEB_URL", "\"https://yappy.gg\"")
      // Backup domain. The app fails over to these if the primary stops
      // resolving, and returns to the primary on the next cold start. Must
      // match the *_ALT names Caddy serves.
      buildConfigField("String", "API_URL_ALT", "\"https://api.tenku.xyz/v1\"")
      buildConfigField("String", "GATEWAY_URL_ALT", "\"wss://ws.tenku.xyz\"")
      signingConfig = signingConfigs.getByName("release")
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

  packaging {
    resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
  }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  implementation(libs.androidx.activity.compose)

  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.ui)
  implementation(libs.androidx.ui.graphics)
  implementation(libs.androidx.ui.tooling.preview)
  implementation(libs.androidx.foundation)
  implementation(libs.androidx.material3)
  implementation(libs.androidx.material.icons.extended)
  debugImplementation(libs.androidx.ui.tooling)

  implementation(libs.androidx.navigation.compose)
  implementation(libs.androidx.datastore.preferences)

  implementation(libs.okhttp)
  implementation(libs.okhttp.logging)
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.kotlinx.coroutines.android)

  implementation(libs.coil.compose)
  implementation(libs.coil.gif)

  // The SFU client. Media never touches our backend — this talks straight to
  // LiveKit using the scoped token the API mints per join.
  implementation(libs.livekit.android)
}
