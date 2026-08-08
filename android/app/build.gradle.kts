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

  buildTypes {
    debug {
      applicationIdSuffix = ".debug"
      // 10.0.2.2 is the host machine as seen from the Android emulator.
      // A physical device needs the LAN IP of the machine running the backend.
      buildConfigField("String", "API_URL", "\"http://10.0.2.2:3000/v1\"")
      buildConfigField("String", "GATEWAY_URL", "\"ws://10.0.2.2:3001\"")
    }
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      buildConfigField("String", "API_URL", "\"https://api.yappy.gg/v1\"")
      buildConfigField("String", "GATEWAY_URL", "\"wss://gateway.yappy.gg\"")
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
