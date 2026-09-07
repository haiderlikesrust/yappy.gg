package gg.yappy.app.ui.media

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.imageLoader
import gg.yappy.app.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.io.File
import kotlin.math.abs

data class CachedMedia(val conversation:String,val title:String,val url:String,val bytes:Long)
object MediaStorage {
    suspend fun entries(context:Context):List<CachedMedia> = withContext(Dispatchers.IO){
        val rows=mutableMapOf<String,CachedMedia>()
        // Only cached message metadata is needed: storage management works offline.
        File(context.cacheDir,"yappy-snapshots").listFiles()?.filter{it.extension=="json"}?.forEach{file->
            runCatching{
                fun visit(element:JsonElement){
                    when(element){
                        is JsonArray->element.forEach{visit(it)}
                        is JsonObject->{
                            val conversation=element["conversationId"]?.jsonPrimitive?.contentOrNull
                            if(conversation!=null)(element["attachments"] as? JsonArray)?.forEach{raw->
                                val a=AppJson.decodeFromJsonElement<Attachment>(raw)
                                listOfNotNull(a.url,a.thumbnailUrl).distinct().forEach{url->
                                    val voice=File(context.cacheDir,"vn-${abs(url.hashCode())}.m4a")
                                    val bytes=(context.imageLoader.diskCache?.openSnapshot(url)?.use{it.data.toFile().length()}?:0L)+(if(voice.exists())voice.length()else 0)
                                    if(bytes>0)rows["$conversation:$url"]=CachedMedia(conversation,a.filename?:"Media",url,bytes)
                                }
                            }
                            element.values.forEach{if(it is JsonObject||it is JsonArray)visit(it)}
                        }
                        else->{}
                    }
                }
                visit(AppJson.parseToJsonElement(file.readText()))
            }
        }
        rows.values.sortedByDescending{it.bytes}
    }
    suspend fun clear(context:Context,items:List<CachedMedia>)=withContext(Dispatchers.IO){
        items.forEach{item->context.imageLoader.diskCache?.remove(item.url);File(context.cacheDir,"vn-${abs(item.url.hashCode())}.m4a").delete()}
        context.imageLoader.memoryCache?.clear()
    }
}

@Composable fun MediaStorageButton(){
    val context=LocalContext.current;val scope=rememberCoroutineScope();var open by remember{mutableStateOf(false)}
    TextButton(onClick={open=true}){Text("Manage downloaded media by chat")}
    if(open){var entries by remember{mutableStateOf(emptyList<CachedMedia>())};var selected by remember{mutableStateOf(emptySet<String>())};var busy by remember{mutableStateOf(true)};var refresh by remember{mutableIntStateOf(0)}
        var names by remember{mutableStateOf(emptyMap<String,String>())}
        LaunchedEffect(refresh){busy=true;names=withContext(Dispatchers.IO){DiskCache.decode<ConversationsEnvelope>("conversations")?.conversations?.associate{it.id to it.displayName}.orEmpty()};entries=MediaStorage.entries(context);busy=false}
        AlertDialog(onDismissRequest={if(!busy)open=false},title={Text("Downloaded media")},text={Column{
            Text("Clear selected downloads. Messages and originals stay in your chats. This lists media linked to chat history cached on this device.")
            if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
            if(!busy&&entries.isEmpty())Text("No indexed media downloads.")
            LazyColumn(Modifier.heightIn(max=360.dp)){
                entries.groupBy{it.conversation}.forEach{(id,files)->
                    item{Row{
                        val keys=files.map{"${it.conversation}:${it.url}"}.toSet()
                        Checkbox(selected.containsAll(keys),{selected=if(it)selected+keys else selected-keys},enabled=!busy)
                        Text("${names[id]?:"Chat …${id.takeLast(8)}"} · ${android.text.format.Formatter.formatShortFileSize(context,files.sumOf{it.bytes})}",Modifier.weight(1f).padding(top=12.dp),style=MaterialTheme.typography.titleSmall)
                    }}
                    items(files,key={"${it.conversation}:${it.url}"}){file->val key="${file.conversation}:${file.url}";Row{
                        Checkbox(key in selected,{selected=if(it)selected+key else selected-key},enabled=!busy)
                        Text("${file.title} · ${android.text.format.Formatter.formatShortFileSize(context,file.bytes)}",Modifier.weight(1f).padding(top=12.dp))
                    }}
                }
            }
        }},confirmButton={TextButton(enabled=!busy&&selected.isNotEmpty(),onClick={busy=true;scope.launch{MediaStorage.clear(context,entries.filter{"${it.conversation}:${it.url}" in selected});selected=emptySet();refresh++}}){Text("Clear selected")}},dismissButton={TextButton(onClick={open=false},enabled=!busy){Text("Close")}})
    }
}
