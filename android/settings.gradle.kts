pluginManagement {
  repositories {
    google {
      content {
        includeGroupByRegex("com\\.android.*")
        includeGroupByRegex("com\\.google.*")
        includeGroupByRegex("androidx.*")
      }
    }
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
    // LiveKit's audio-routing dependency (davidliu/audioswitch) is published
    // only on JitPack. Scoped to that one group so a compromised JitPack
    // artifact cannot shadow anything we pull from Maven Central.
    maven("https://jitpack.io") {
      content { includeGroup("com.github.davidliu") }
    }
  }
}

rootProject.name = "yappy"
include(":app")
