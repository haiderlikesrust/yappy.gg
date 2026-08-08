# kotlinx.serialization keeps its metadata in synthetic members that R8 strips
# by default, which turns every @Serializable class into a runtime crash.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep,includedescriptorclasses class gg.yappy.app.**$$serializer { *; }
-keepclassmembers class gg.yappy.app.** {
    *** Companion;
}
-keepclasseswithmembers class gg.yappy.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
