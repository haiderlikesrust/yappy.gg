package gg.yappy.app.ui.media

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.*
import gg.yappy.app.ui.components.AppHeader
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import java.util.UUID

@Composable fun MediaTile(attachment:Attachment,modifier:Modifier=Modifier){
    var revealed by rememberSaveable(attachment.id){mutableStateOf(false)}
    var opened by remember{mutableStateOf(false)};val container=LocalContainer.current
    val hidden=attachment.isSpoiler&&!revealed
    Box(modifier.clip(RoundedCornerShape(14.dp)).background(neuColors.surfaceRaised).softClickable{
        if(hidden)revealed=true else opened=true
    },contentAlignment=Alignment.Center){
        if(hidden)Text("Spoiler\nTap to reveal",Modifier.padding(12.dp),color=neuColors.textPrimary)
        else{
            AsyncImage(attachment.thumbnailUrl?:attachment.url,attachment.caption?:attachment.filename,contentScale=ContentScale.Crop,modifier=Modifier.fillMaxSize())
            if(attachment.mimeType.startsWith("video/"))Surface(shape=RoundedCornerShape(24.dp)){Text("▶",Modifier.padding(12.dp))}
        }
    }
    if(opened){
        if(attachment.mimeType.startsWith("video/"))VideoPlayerScreen(attachment.url,container.mediaFactory,{opened=false})
        else MediaViewer(listOf(ViewerItem(attachment.url,caption=attachment.caption,filename=attachment.filename)),0,{opened=false})
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable fun SharedGalleryScreen(conversationId:String,onClose:()->Unit){
    val container=LocalContainer.current;val api=container.repo.extras;val scope=rememberCoroutineScope();val handler=LocalUriHandler.current
    val context=LocalContext.current
    var tab by rememberSaveable{mutableStateOf("photos")};var wall by remember{mutableStateOf<PhotoWall?>(null)}
    var walls by remember{mutableStateOf(emptyList<PhotoWall>())};var page by remember{mutableStateOf(GalleryPage())}
    var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var refresh by remember{mutableIntStateOf(0)}
    var title by remember{mutableStateOf<String?>(null)};var adding by remember{mutableStateOf<Message?>(null)};var user by remember{mutableStateOf<String?>(null)}
    var isGroup by remember{mutableStateOf(false)}
    var pagination by remember{mutableStateOf<kotlinx.coroutines.Job?>(null)}
    BackHandler{if(wall!=null)wall=null else onClose()}
    LaunchedEffect(conversationId,tab,wall?.id,refresh){pagination?.cancelAndJoin();busy=true;error=null;page=GalleryPage();try{
        user=container.session.currentUserId();isGroup=container.repo.conversation(conversationId).conversation.type!="dm"
        if(tab=="albums"&&wall==null){walls=api.walls(conversationId).walls;page=GalleryPage()}
        else page=wall?.let{api.wall(it.id)}?:api.gallery(conversationId,tab)
    }catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){error="Couldn’t load media. Please try again."}finally{busy=false}}
    fun loadMore(){busy=true;pagination=scope.launch{try{val next=wall?.let{api.wall(it.id,page.messages.lastOrNull()?.seq)}?:api.gallery(conversationId,tab,page.messages.lastOrNull()?.seq);page=next.copy(messages=(page.messages+next.messages).distinctBy{it.id})}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){error="Couldn’t load more media."}finally{busy=false}}}
    Surface(Modifier.fillMaxSize()){
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()){
            AppHeader(wall?.title?:"Shared media",{if(wall!=null)wall=null else onClose()})
            FlowRow(Modifier.padding(horizontal=16.dp),horizontalArrangement=Arrangement.spacedBy(6.dp)){
                (listOf("photos","videos","files","links")+if(isGroup)listOf("albums")else emptyList()).forEach{k->FilterChip(tab==k,{tab=k;wall=null},label={Text(k.replaceFirstChar{it.uppercase()})})}
            }
            LazyColumn(Modifier.weight(1f),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
                if(busy)item{LinearProgressIndicator(Modifier.fillMaxWidth())}
                error?.let{item{Text(it);TextButton(onClick={refresh++}){Text("Try again")}}}
                if(tab=="albums"&&wall==null){
                    item{Text("Collect photos and videos from this group into shared albums. Members can contribute from the Photos and Videos tabs.")}
                    item{Button(onClick={title=""},enabled=!busy){Text("Create album")}}
                    items(walls,key={it.id}){w->Card(onClick={wall=w},modifier=Modifier.fillMaxWidth()){Column(Modifier.padding(16.dp)){Text(w.title,style=MaterialTheme.typography.titleMedium);Text("${w.count} contributions")}}}
                }else{
                    if(!busy&&error==null&&page.messages.isEmpty())item{Text(if(wall!=null)"Add photos and videos from this chat to start this album."else "Nothing shared here yet.")}
                    if(wall?.creatorId==user&&wall!=null)item{Row{
                        TextButton(onClick={title=wall!!.title}){Text("Rename album")}
                        var confirm by remember{mutableStateOf(false)}
                        TextButton(onClick={confirm=true}){Text("Delete album")}
                        if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("Delete album?")},text={Text("The photos and messages stay in the chat.")},confirmButton={TextButton(onClick={confirm=false;scope.launch{try{api.deleteWall(wall!!.id);wall=null;refresh++}catch(e:Exception){error=e.message}}}){Text("Delete")}},dismissButton={TextButton(onClick={confirm=false}){Text("Cancel")}})
                    }}
                    page.messages.groupBy{it.createdAt.take(7)}.forEach{(month,messages)->
                        item(key="month-$month"){Text(month,style=MaterialTheme.typography.titleMedium)}
                        items(messages,key={it.id}){message->Card(Modifier.fillMaxWidth()){
                            Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
                                Text(message.sender?.label?:"Member",style=MaterialTheme.typography.labelMedium)
                                if(tab=="links"){
                                    Text(message.content.orEmpty())
                                    Regex("https?://[^\\s<>()]+").findAll(message.content.orEmpty()).take(6).forEach{link->TextButton(onClick={runCatching{handler.openUri(link.value)}}){Text(link.value,maxLines=1)}}
                                }else message.attachments.forEach{a->
                                    if(a.mimeType.startsWith("image/")||a.mimeType.startsWith("video/"))MediaTile(a,Modifier.fillMaxWidth().height(180.dp))
                                    else {
                                        var opening by remember(a.id){mutableStateOf(false)}
                                        TextButton(enabled=!opening,onClick={opening=true;scope.launch{
                                            try {
                                                val local=stageForShare(context,container,ViewerItem(a.url,filename=a.filename))?:error("Couldn’t download this file.")
                                                context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(local,a.mimeType).addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION))
                                            }catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:android.content.ActivityNotFoundException){error="No installed app can open this file type."}catch(e:Exception){error="Couldn’t open this file. Please try again."}finally{opening=false}
                                        }}){Text(if(opening)"Downloading…"else a.filename?:"Open file")}
                                    }
                                    a.caption?.takeIf{it.isNotBlank()}?.let{Text(it)}
                                }
                                if(tab!="links"&&!message.content.isNullOrBlank())Text(message.content!!)
                                if(isGroup&&(tab=="photos"||tab=="videos"))TextButton(onClick={scope.launch{try{walls=api.walls(conversationId).walls;adding=message}catch(e:Exception){error=e.message}}}){Text("Add to shared album")}
                                if(wall!=null)TextButton(onClick={scope.launch{try{api.removeFromWall(wall!!.id,message.id);refresh++}catch(e:Exception){error="Only the contributor or album creator can remove this item."}}}){Text("Remove from album")}
                            }
                        }}
                    }
                    if(page.hasMore)item{TextButton(onClick={loadMore()},enabled=!busy){Text("Load more")}}
                }
            }
        }
    }
    title?.let{initial->var name by remember(initial){mutableStateOf(initial)};var saving by remember{mutableStateOf(false)};var failure by remember{mutableStateOf<String?>(null)}
        AlertDialog(onDismissRequest={if(!saving)title=null},title={Text("Shared album")},text={Column{OutlinedTextField(name,{name=it.take(80)},label={Text("Name")});failure?.let{Text(it)}}},confirmButton={TextButton(enabled=!saving&&name.isNotBlank(),onClick={saving=true;scope.launch{try{api.saveWall(conversationId,wall?.id?:UUID.randomUUID().toString(),name.trim());wall=wall?.copy(title=name);title=null;refresh++}catch(e:Exception){failure=e.message}finally{saving=false}}}){Text("Save")}},dismissButton={TextButton(onClick={title=null},enabled=!saving){Text("Cancel")}})
    }
    adding?.let{message->AlertDialog(onDismissRequest={adding=null},title={Text("Add to album")},text={LazyColumn{if(walls.isEmpty())item{Text("Create an album in the Albums tab first.")};items(walls,key={it.id}){w->TextButton(onClick={scope.launch{try{api.addToWall(w.id,message.id);adding=null}catch(e:Exception){error=e.message;adding=null}}}){Text(w.title)}}}},confirmButton={TextButton(onClick={adding=null}){Text("Close")}})}
}
