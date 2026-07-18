package life.nineli.melodex

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SettingsStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun load(): SubsonicCredentials? {
        val serverUrl = preferences.getString(KEY_SERVER_URL, null).orEmpty()
        val username = preferences.getString(KEY_USERNAME, null).orEmpty()
        val encryptedPassword = preferences.getString(KEY_PASSWORD, null).orEmpty()
        val iv = preferences.getString(KEY_PASSWORD_IV, null).orEmpty()
        if (serverUrl.isBlank() || username.isBlank() || encryptedPassword.isBlank() || iv.isBlank()) return null
        return try {
            SubsonicCredentials(serverUrl, username, decrypt(encryptedPassword, iv))
        } catch (error: Exception) {
            Log.e(TAG, "读取服务器凭据失败", error)
            null
        }
    }

    fun save(credentials: SubsonicCredentials) {
        val encrypted = encrypt(credentials.password)
        preferences.edit()
            .putString(KEY_SERVER_URL, credentials.serverUrl)
            .putString(KEY_USERNAME, credentials.username)
            .putString(KEY_PASSWORD, encrypted.payload)
            .putString(KEY_PASSWORD_IV, encrypted.iv)
            .apply()
    }

    private fun encrypt(value: String): EncryptedValue {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        return EncryptedValue(
            payload = Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP),
            iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
        )
    }

    private fun decrypt(payload: String, iv: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        val ivBytes = Base64.decode(iv, Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, ivBytes))
        return cipher.doFinal(Base64.decode(payload, Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    private data class EncryptedValue(val payload: String, val iv: String)

    companion object {
        private const val TAG = "MelodexSettings"
        private const val PREFERENCES_NAME = "melodex_android_settings"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_USERNAME = "username"
        private const val KEY_PASSWORD = "password"
        private const val KEY_PASSWORD_IV = "password_iv"
        private const val KEY_ALIAS = "melodex_subsonic_password"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
