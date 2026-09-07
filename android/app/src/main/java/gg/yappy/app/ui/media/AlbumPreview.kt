package gg.yappy.app.ui.media

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.*
import gg.yappy.app.ui.components.AppHeader
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun AlbumPreview(uris:List<Uri>,conversationId:String,initialCaption:String,onClose:()->Unit,onQueued:()->Unit){
    val context=LocalContext.current;val container=LocalContainer.current;val scope=rememberCoroutineScope()
    var files by remember(uris){mutableStateOf(uris)};var captions by remember(uris){mutableStateOf(uris.map{""})}
    var selected by remember{mutableIntStateOf(0)};var caption by remember{mutableStateOf(initialCaption)}
    var spoiler by remember{mutableStateOf(false)};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)}
    var editing by remember{mutableStateOf(false)};var play by remember{mutableStateOf(false)}
    BackHandler{if(!busy)onClose()}
    Surface(Modifier.fillMaxSize()){
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()){
            AppHeader(if(files.size==1)"Send media" else "Album · ${files.size}",{if(!busy)onClose()})
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal=16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
                AsyncImage(files[selected],"Selected attachment",modifier=Modifier.fillMaxWidth().height(230.dp),contentScale=ContentScale.Fit)
                if(MediaEditor.video(context,files[selected]))TextButton(onClick={play=true},enabled=!busy){Text("Play video")}
                LazyRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){itemsIndexed(files){i,uri->
                    OutlinedButton(onClick={selected=i},enabled=!busy,contentPadding=PaddingValues(3.dp)){AsyncImage(uri,"Attachment ${i+1}",modifier=Modifier.size(54.dp),contentScale=ContentScale.Crop)}
                }}
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                    TextButton(onClick={editing=true},enabled=!busy){Text("Edit / quality")}
                    TextButton(enabled=!busy&&selected>0,onClick={
                        val f=files.toMutableList();java.util.Collections.swap(f,selected,selected-1);files=f
                        val c=captions.toMutableList();java.util.Collections.swap(c,selected,selected-1);captions=c;selected--
                    }){Text("Move left")}
                    TextButton(enabled=!busy&&files.size>1,onClick={files=files.filterIndexed{i,_->i!=selected};captions=captions.filterIndexed{i,_->i!=selected};selected=selected.coerceAtMost(files.lastIndex)}){Text("Remove")}
                }
                if(files.size>1)OutlinedTextField(captions[selected],{value->captions=captions.mapIndexed{i,c->if(i==selected)value.take(1000)else c}},label={Text("Caption for this attachment")},modifier=Modifier.fillMaxWidth(),enabled=!busy)
                OutlinedTextField(caption,{caption=it.take(4000)},label={Text("Album caption")},modifier=Modifier.fillMaxWidth(),enabled=!busy,maxLines=4)
                Row(verticalAlignment=Alignment.CenterVertically){Checkbox(spoiler,{spoiler=it},enabled=!busy);Text("Hide media until tapped (spoiler)")}
                error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
            }
            Button(enabled=!busy,onClick={busy=true;error=null;scope.launch{try{
                val user=container.session.currentUserId()?:error("Sign in before sending")
                MediaUploadQueue.enqueue(context,user,conversationId,files,captions,caption,spoiler);onQueued()
            }catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},modifier=Modifier.fillMaxWidth().padding(16.dp)){Text(if(busy)"Preparing upload…"else "Send ${files.size} attachment${if(files.size>1)"s"else ""}")}
        }
    }
    if(editing)MediaEditDialog(files[selected],onClose={editing=false},onApply={uri->files=files.mapIndexed{i,f->if(i==selected)uri else f};editing=false})
    if(play)VideoPlayerScreen(url=files[selected].toString(),mediaFactory=container.mediaFactory,onDismiss={play=false})
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun MediaEditDialog(uri:Uri,onClose:()->Unit,onApply:(Uri)->Unit){
    val context=LocalContext.current;val container=LocalContainer.current;val scope=rememberCoroutineScope()
    val video=remember(uri){MediaEditor.video(context,uri)};var edit by remember{mutableStateOf(MediaEdit())}
    var duration by remember{mutableLongStateOf(0)};var trim by remember{mutableStateOf(0f..1f)}
    var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var saved by remember{mutableStateOf(false)}
    LaunchedEffect(uri){if(video)try{duration=MediaEditor.duration(context,uri);trim=0f..(duration/1000f).coerceAtLeast(1f)}catch(e:Exception){error="Couldn’t read video duration."}}
    AlertDialog(onDismissRequest={if(!busy)onClose()},title={Text(if(video)"Edit video"else "Edit photo / make sticker")},text={
        Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(6.dp)){
            AsyncImage(uri,"Original",Modifier.fillMaxWidth().height(130.dp),contentScale=ContentScale.Fit)
            if(video){
                Text("Trim: ${trim.start.toInt()}–${trim.endInclusive.toInt()} seconds")
                if(duration>1000)RangeSlider(trim,{trim=it},valueRange=0f..(duration/1000f),enabled=!busy)
                Row{Checkbox(edit.mute,{edit=edit.copy(mute=it)},enabled=!busy);Text("Mute audio",Modifier.padding(top=12.dp))}
            }else{
                TextButton(onClick={edit=edit.copy(turns=(edit.turns+1)%4)},enabled=!busy){Text("Rotate · ${edit.turns*90}°")}
                Text("Crop")
                LazyRow{itemsIndexed(listOf("Original" to 0f,"Square" to 1f,"Portrait" to 0.75f,"Landscape" to 1.7778f)){_,(label,ratio)->FilterChip(edit.cropRatio==ratio,{edit=edit.copy(cropRatio=ratio)},label={Text(label)},enabled=!busy)}}
                if(edit.cropRatio>0){Text("Crop position: horizontal / vertical");Slider(edit.cropX,{edit=edit.copy(cropX=it)},enabled=!busy);Slider(edit.cropY,{edit=edit.copy(cropY=it)},enabled=!busy)}
                OutlinedTextField(edit.text,{edit=edit.copy(text=it.take(80))},label={Text("Text on photo")},enabled=!busy)
            }
            Row{Checkbox(edit.hd,{edit=edit.copy(hd=it)},enabled=!busy);Text(if(edit.hd)"HD quality"else "Standard · smaller upload",Modifier.padding(top=12.dp))}
            if(!video)TextButton(enabled=!busy,onClick={busy=true;error=null;scope.launch{try{
                val rendered=MediaEditor.render(context,uri,edit.copy(sticker=true));val uploaded=container.uploader.upload(rendered,"sticker")
                val user=container.session.currentUserId()?:error("Sign in first")
                val prefs=context.getSharedPreferences("sticker-maker",0)
                val pack=prefs.getString(user,null)?:container.repo.extras.createStickerPack("My creations","made-${UUID.randomUUID()}")["pack"]!!.jsonObject["id"]!!.jsonPrimitive.content.also{prefs.edit().putString(user,it).apply()}
                container.repo.extras.addSticker(pack,uploaded.mediaId,edit.text.ifBlank{"My sticker"});saved=true
            }catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}){Text(if(saved)"Saved to My creations"else "Save as sticker")}
            error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
            if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    },confirmButton={TextButton(enabled=!busy&&(!video||trim.endInclusive-trim.start>=0.5f),onClick={busy=true;error=null;scope.launch{try{
        onApply(MediaEditor.render(context,uri,edit.copy(startMs=(trim.start*1000).toLong(),endMs=if(video)(trim.endInclusive*1000).toLong()else 0)))
    }catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}){Text("Apply edits")}},dismissButton={TextButton(onClick=onClose,enabled=!busy){Text("Cancel")}})
}
