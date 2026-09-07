package gg.yappy.app.ui.media

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Edit
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.QuietIconButton
import gg.yappy.app.ui.theme.neuColors
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.work.WorkManager
import androidx.work.WorkInfo
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.*
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun FolderControls(
    conversations:List<Conversation>, selected:String?, onSelect:(String?)->Unit,
    onFolders:(List<ChatFolder>)->Unit,
    tabs:@Composable (List<ChatFolder>,()->Unit)->Unit,
){
    val api=LocalContainer.current.repo.extras;val scope=rememberCoroutineScope()
    val colors=neuColors
    var folders by remember { mutableStateOf(emptyList<ChatFolder>()) };var edit by remember { mutableStateOf<ChatFolder?>(null) }
    var managing by rememberSaveable{mutableStateOf(false)}
    var busy by remember{mutableStateOf(false)}
    var refresh by remember{mutableIntStateOf(0)};var error by remember{mutableStateOf<String?>(null)}
    LaunchedEffect(refresh){try{folders=api.folders().folders;onFolders(folders);if(selected!=null&&folders.none{it.id==selected})onSelect(null);error=null}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){error="Couldn’t load folders."}}
    tabs(folders){managing=true}
    if(managing)ModalBottomSheet(
        onDismissRequest={if(!busy){managing=false;edit=null}},
        sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true),
        containerColor=colors.surface,contentColor=colors.textPrimary,
    ){
      Column(Modifier.fillMaxWidth().imePadding().padding(horizontal=24.dp).padding(bottom=24.dp),verticalArrangement=Arrangement.spacedBy(16.dp)){
        Text(if(edit==null)"Chat folders"else if(edit!!.name.isEmpty())"Create folder"else "Edit folder",style=MaterialTheme.typography.headlineSmall)
        if(edit==null){
            Text("Keep the conversations you care about together.",style=MaterialTheme.typography.bodyMedium,color=colors.textSecondary)
            error?.let{Text(it,color=colors.danger);TextButton(onClick={refresh++}){Text("Try again")}}
            if(folders.isNotEmpty())LazyColumn(Modifier.heightIn(max=300.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
                items(folders,key={it.id}){folder->
                    Surface(shape=RoundedCornerShape(16.dp),color=colors.surfaceRaised){
                        Row(Modifier.fillMaxWidth().padding(start=16.dp,top=8.dp,bottom=8.dp,end=4.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){
                            Icon(Icons.Rounded.Folder,null,tint=colors.accent)
                            Column(Modifier.weight(1f)){
                                Text(folder.name,maxLines=1,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.titleSmall)
                                Text("${folder.conversationIds.size} chats",style=MaterialTheme.typography.bodySmall,color=colors.textSecondary)
                            }
                            QuietIconButton(Icons.Rounded.Edit,"Edit ${folder.name}",{edit=folder})
                        }
                    }
                }
            }
            NeuButton(onClick={edit=ChatFolder(UUID.randomUUID().toString(),"")},modifier=Modifier.fillMaxWidth(),accent=true){Text("Create folder")}
        }
    edit?.let{folder->
        var name by remember(folder.id){mutableStateOf(folder.name)};var chosen by remember(folder.id){mutableStateOf(folder.conversationIds.toSet())}
        var failure by remember(folder.id){mutableStateOf<String?>(null)}
        fun save(remove:Boolean=false){busy=true;scope.launch{try{if(remove)api.deleteFolder(folder.id)else api.saveFolder(folder.copy(name=name.trim(),conversationIds=chosen.toList()));edit=null;refresh++;if(!remove){onSelect(folder.id);managing=false}}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){failure="Couldn’t save your folder. Please try again."}finally{busy=false}}}
            OutlinedTextField(name,{name=it.take(40)},label={Text("Folder name")},placeholder={Text("Friends, work, favourites…")},enabled=!busy,singleLine=true,shape=RoundedCornerShape(16.dp),modifier=Modifier.fillMaxWidth())
            Text("Choose chats · ${chosen.size} selected",style=MaterialTheme.typography.labelLarge,color=colors.textSecondary)
            LazyColumn(Modifier.weight(1f,fill=false).heightIn(max=300.dp)){items(conversations.distinctBy{it.id},key={it.id}){c->
                Row(Modifier.fillMaxWidth().heightIn(min=48.dp).toggleable(c.id in chosen,enabled=!busy){checked->chosen=if(checked)chosen+c.id else chosen-c.id}.padding(vertical=4.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){
                    Checkbox(c.id in chosen,null,enabled=!busy)
                    Text(c.displayName,Modifier.weight(1f),maxLines=1,overflow=TextOverflow.Ellipsis)
                }
            }}
            failure?.let{Text(it,color=MaterialTheme.colorScheme.error)}
            NeuButton(onClick={save()},enabled=!busy&&name.isNotBlank(),modifier=Modifier.fillMaxWidth(),accent=true){Text(if(busy)"Saving…"else "Save folder")}
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
                TextButton(onClick={edit=null},enabled=!busy){Text("Cancel")}
                if(folder.name.isNotEmpty())TextButton(onClick={save(true)},enabled=!busy){Text("Delete folder",color=colors.danger)}
            }
            if(folder.name.isNotEmpty())Text("Deleting a folder keeps your chats.",style=MaterialTheme.typography.bodySmall,color=colors.textSecondary)
    }
      }
    }
}

@Composable fun QuickStatusButton(){
    val container=LocalContainer.current;val repo=container.repo;val scope=rememberCoroutineScope();var open by remember{mutableStateOf(false)}
    TextButton(onClick={open=true}){Text("Set a quick status")}
    if(open){
        var text by rememberSaveable{mutableStateOf(container.me.value?.presence?.customStatus.orEmpty())};var hours by rememberSaveable{mutableIntStateOf(4)}
        var audience by rememberSaveable{mutableStateOf("contacts")};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)}
        LaunchedEffect(Unit){audience=container.me.value?.privacy?.get("lastSeen")?.let{(it as? kotlinx.serialization.json.JsonPrimitive)?.content}?:"contacts"}
        AlertDialog(onDismissRequest={if(!busy)open=false},title={Text("What are you up to?")},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)){
            listOf("🎮 Gaming","📚 Studying","💬 Free to talk").forEach{value->TextButton(onClick={text=value},enabled=!busy){Text(value)}}
            OutlinedTextField(text,{text=it.take(128)},label={Text("Your status")},enabled=!busy)
            Text("Clear after")
            Row{listOf(1,4,24).forEach{h->FilterChip(hours==h,{hours=h},label={Text("${h}h")},enabled=!busy)}}
            Text("Audience also controls online and last-seen visibility.",style=MaterialTheme.typography.bodySmall)
            Column{listOf("everyone" to "Everyone","contacts" to "Contacts","nobody" to "Nobody").forEach{(v,label)->FilterChip(audience==v,{audience=v},label={Text(label)},enabled=!busy)}}
            error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        }},confirmButton={TextButton(enabled=!busy,onClick={busy=true;scope.launch{try{
            val me=repo.me().user;repo.updatePrivacy("lastSeen",audience)
            repo.setPresence(me.presence.status,text,Instant.now().plusSeconds(hours*3600L).toString());container.refreshMe();open=false
        }catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}){Text(if(busy)"Saving…" else if(text.isBlank())"Clear status" else "Save")}},dismissButton={TextButton(onClick={open=false},enabled=!busy){Text("Cancel")}})
    }
}

@Composable fun TranscriptButton(message:Message,onAccent:Boolean=false){
    if(message.isEncrypted||message.isPending)return
    val api=LocalContainer.current.repo.extras;val scope=rememberCoroutineScope()
    var consent by remember{mutableStateOf(false)};var text by remember(message.id){mutableStateOf<String?>(null)}
    var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)}
    val textColor=if(onAccent)gg.yappy.app.ui.theme.neuColors.onOutgoing else gg.yappy.app.ui.theme.neuColors.textPrimary
    TextButton(onClick={consent=true},enabled=!busy,colors=ButtonDefaults.textButtonColors(contentColor=textColor)){Text(if(busy)"Transcribing…" else "Transcribe")}
    text?.let{androidx.compose.foundation.text.selection.SelectionContainer{Text(it,style=MaterialTheme.typography.bodyMedium,color=textColor)}}
    error?.let{Text(it,style=MaterialTheme.typography.bodySmall,color=textColor)}
    if(consent)AlertDialog(onDismissRequest={consent=false},title={Text("Transcribe this voice note?")},text={Text("The audio will be processed on Yappy’s own transcription server. The transcript is only shown to you and may contain mistakes.")},confirmButton={TextButton(onClick={consent=false;busy=true;error=null;scope.launch{try{text=api.transcribe(message.id).text.ifBlank{"No speech detected."}}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){error=if(e is ApiException&&e.status==503)e.message else "Couldn’t transcribe. Please try again."}finally{busy=false}}}){Text("Transcribe")}},dismissButton={TextButton(onClick={consent=false}){Text("Cancel")}})
}

@Composable fun UploadQueuePanel(conversationId:String){
    val context=LocalContext.current;val scope=rememberCoroutineScope()
    val flow=remember(conversationId){WorkManager.getInstance(context).getWorkInfosByTagFlow("uploads-$conversationId")}
    val work by flow.collectAsState(initial=emptyList())
    val preferences=remember{context.getSharedPreferences("dismissed-uploads",0)}
    var dismissed by remember(conversationId){mutableStateOf(preferences.getStringSet(conversationId,emptySet())!!.toSet())}
    var actionError by remember{mutableStateOf<String?>(null)}
    val pending=work.filter{it.state!=WorkInfo.State.SUCCEEDED&&it.id.toString() !in dismissed}
    if(pending.isNotEmpty())Column(Modifier.heightIn(max=180.dp).verticalScroll(rememberScrollState())){
    actionError?.let{Text(it,Modifier.padding(horizontal=14.dp),color=MaterialTheme.colorScheme.error)}
    pending.forEach{info->
        val id=info.tags.firstOrNull{it.startsWith("draft-")}?.removePrefix("draft-")
        if(id!=null)Card(Modifier.fillMaxWidth().padding(horizontal=14.dp,vertical=4.dp)){
            Column(Modifier.padding(12.dp)){
                val phase=info.progress.getString("phase")
                Text(when(info.state){WorkInfo.State.FAILED->info.outputData.getString("error")?:"Upload failed";WorkInfo.State.CANCELLED->"Upload cancelled";WorkInfo.State.ENQUEUED->"Waiting to upload";else->when(phase){
                    "connecting"->"Connecting to the upload server…"
                    "confirming"->"Checking the uploaded file…"
                    "sending"->"Sending your message…"
                    "uploading"->"Uploading ${info.progress.getInt("percent",0)}% · file ${info.progress.getInt("item",1)} of ${info.progress.getInt("total",1)}"
                    else->"Preparing your media…"
                }})
                if(info.state==WorkInfo.State.RUNNING){
                    if(phase=="uploading")LinearProgressIndicator(progress={info.progress.getInt("percent",0)/100f},modifier=Modifier.fillMaxWidth())
                    else LinearProgressIndicator(modifier=Modifier.fillMaxWidth())
                }
                Row{
                    if(info.state.isFinished){TextButton(onClick={scope.launch{try{MediaUploadQueue.retry(context,id);actionError=null}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){actionError="Couldn’t retry. Select the media again if its local files were removed."}}}){Text("Retry")};TextButton(onClick={scope.launch{try{MediaUploadQueue.discard(context,id);dismissed=dismissed+info.id.toString();preferences.edit().putStringSet(conversationId,dismissed).apply();actionError=null}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){actionError=e.message}}}){Text("Discard")}}
                    else TextButton(onClick={scope.launch{try{MediaUploadQueue.cancel(context,id)}catch(e:kotlinx.coroutines.CancellationException){throw e}catch(e:Exception){actionError="Couldn’t cancel. Please try again."}}}){Text("Cancel")}
                }
            }
        }
    }
    }
}
