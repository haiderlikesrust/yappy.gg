import SwiftUI

struct CommunityScreen: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.neu) private var colors
    var conversationId: String? = nil
    let onOpenMessage: (String, Int64?) -> Void
    var onOpenGroup: (String) -> Void = { _ in }
    @State private var tab = "Catch up"
    @State private var version = 0
    @State private var loading = true
    @State private var busy = false
    @State private var error: String?
    @State private var catchUp: CommunityCatchUp?
    @State private var events: [CommunityEvent] = []
    @State private var reminders: [CommunityReminder] = []
    @State private var scheduled: [CommunityScheduled] = []
    @State private var saved: [CollectionItem] = []
    @State private var collections: [SavedCollection] = []
    @State private var welcome: CommunityWelcome?
    @State private var query = ""
    @State private var collectionId = ""
    @State private var editor: CommunityEditorTarget?
    @State private var cancelEvent: CommunityEvent?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(conversationId == nil ? ["Catch up", "Events", "Reminders", "Scheduled", "Saved"] : ["Welcome", "Events"], id: \.self) { section in
                        Button(section) { tab = section }
                            .buttonStyle(.bordered).tint(tab == section ? colors.accent : colors.textSecondary)
                            .accessibilityAddTraits(tab == section ? .isSelected : [])
                    }
                }.padding(.horizontal, 16).padding(.vertical, 8)
            }
            Form {
                if loading { ProgressView("Loading…") }
                if let error { Section { Text(error).foregroundStyle(colors.danger); Button("Try again") { version += 1 } } }
                switch tab {
                case "Catch up": catchUpRows
                case "Events": eventRows
                case "Reminders": reminderRows
                case "Scheduled": scheduledRows
                case "Saved": savedRows
                default: welcomeRows
                }
            }
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
        .background(colors.surface).foregroundStyle(colors.textPrimary).tint(colors.accent)
        .navigationTitle(conversationId == nil ? "Catch up" : "Events & welcome")
        .navigationBarTitleDisplayMode(.inline).toolbar(.visible, for: .navigationBar)
        .onAppear { if conversationId != nil && tab == "Catch up" { tab = "Welcome" } }
        .task(id: "\(tab):\(version):\(query):\(collectionId)") {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }; await load()
        }
        .sheet(item: $editor) { target in
            NavigationStack { CommunityEditor(target: target) { version += 1 } }
                .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .confirmationDialog("Cancel this event for everyone?", isPresented: Binding(get: { cancelEvent != nil }, set: { if !$0 { cancelEvent = nil } })) {
            if let event = cancelEvent { Button("Cancel event", role: .destructive) { change("DELETE", "/events/\(event.id)"); cancelEvent = nil } }
        }
    }

    @ViewBuilder private var catchUpRows: some View {
        Section("Waiting for you") {
            if !loading && catchUp?.items.isEmpty != false { Text("You’re caught up. New mentions, replies, pins, and group updates appear here.").foregroundStyle(colors.textSecondary) }
            ForEach(catchUp?.items ?? []) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(item.kind) · \(item.conversationTitle ?? "Direct message")").font(.caption).foregroundStyle(colors.textSecondary)
                    Text(item.title).font(.headline); Text(item.body)
                    Button("View message") { onOpenMessage(item.conversationId, item.seq) }
                }.padding(.vertical, 6)
            }
        }
        Section("Unread conversations") {
            ForEach(catchUp?.rooms ?? []) { room in Button { onOpenMessage(room.conversationId, nil) } label: { VStack(alignment: .leading) { Text(room.title); Text("\(room.unreadCount) unread").font(.caption).foregroundStyle(colors.textSecondary) } } }
        }
    }

    @ViewBuilder private var eventRows: some View {
        Section {
            Text("Plans with your people, shown in your local time zone.")
            if let conversationId, welcome?.canManage == true { Button("Create event", systemImage: "calendar.badge.plus") { editor = .event(conversationId, nil) } }
            if !loading && events.isEmpty { Text("The calendar’s open. Group admins can create an event from Events & welcome on the group page.").foregroundStyle(colors.textSecondary) }
        }
        ForEach(events) { event in
            Section(event.conversationTitle) {
                Text(event.title).font(.headline); Text(CommunityTime.label(event.startsAt))
                if let end = event.endsAt { Text("Until \(CommunityTime.label(end))").font(.subheadline) }
                if event.cancelledAt != nil { Text("Cancelled").foregroundStyle(colors.textSecondary) }
                else {
                    if !event.description.isEmpty { Text(event.description) }; if !event.location.isEmpty { Text(event.location) }
                    Text("\(event.going) going · \(event.maybe) maybe").font(.caption)
                    if CommunityTime.date(event.startsAt) > Date() {
                        Picker("Your RSVP", selection: Binding(get: { event.response ?? "" }, set: { value in change("PUT", "/events/\(event.id)/rsvp", jsonBody(["response": .string(value), "remind": .bool(event.remind)])) })) {
                            Text("Choose…").tag(""); Text("Going").tag("going"); Text("Maybe").tag("maybe"); Text("Can’t go").tag("declined")
                        }.disabled(busy)
                        Toggle("Remind me 15 minutes before", isOn: Binding(get: { event.remind }, set: { value in change("PUT", "/events/\(event.id)/rsvp", jsonBody(["response": .string(event.response ?? "going"), "remind": .bool(value)])) }))
                            .disabled(busy || event.response == nil || event.response == "declined")
                        if event.canManage || welcome?.canManage == true {
                            Button("Edit event") { editor = .event(event.conversationId, event) }
                            Button("Cancel event", role: .destructive) { cancelEvent = event }
                        }
                    }
                }
                Button("Open group") { onOpenGroup(event.conversationId) }
            }
        }
    }

    @ViewBuilder private var reminderRows: some View {
        if !loading && reminders.isEmpty { Section { Text("Nothing on your list. Hold a message and choose Remind me to get a notification linking back to it.") } }
        ForEach(reminders) { reminder in Section {
            Text(CommunityTime.label(reminder.dueAt)).font(.caption); Text(reminder.title)
            Button("Open conversation") { onOpenMessage(reminder.conversationId, reminder.seq) }
            Button("Cancel reminder", role: .destructive) { change("DELETE", "/reminders/\(reminder.id)") }.disabled(busy)
        } }
    }
    @ViewBuilder private var scheduledRows: some View {
        if !loading && scheduled.isEmpty { Section { Text("No scheduled messages. Write a message, then choose Schedule from the attachment menu.") } }
        ForEach(scheduled) { message in Section(message.conversationTitle ?? "Conversation") {
            Text(CommunityTime.label(message.sendAt)).font(.caption); Text(message.content)
            if let failure = message.failure { Text("Not sent: \(failure)").foregroundStyle(colors.danger) }
            Button(message.failedAt == nil ? "Cancel scheduled message" : "Dismiss", role: .destructive) { change("DELETE", "/scheduled/\(message.id)") }.disabled(busy)
        } }
    }
    @ViewBuilder private var savedRows: some View {
        Section {
            TextField("Search messages and notes", text: $query)
            Picker("Collection", selection: $collectionId) { Text("All saved").tag(""); ForEach(collections) { c in Text("\(c.name) · \(c.count)").tag(c.id) } }
            if let folder = collections.first(where: { $0.id == collectionId }) { Button("Manage collection") { editor = .collection(folder) } }
            if !loading && saved.isEmpty { Text("Keep the good stuff here. Hold a message to save it, then organize it with collections and private notes.").foregroundStyle(colors.textSecondary) }
        }
        ForEach(saved) { item in Section {
            Text("\(item.sender) · \(item.conversationTitle ?? "Direct message")").font(.caption).foregroundStyle(colors.textSecondary)
            Text(item.content); if !item.note.isEmpty { Text("Note: \(item.note)") }
            Button("View message") { onOpenMessage(item.conversationId, item.seq) }
            Button("Collection & note") { editor = .saved(item) }
            Button("Remove", role: .destructive) {
                guard !busy else { return }; busy = true
                Task { do { try await container.repo.api.send("DELETE", "/conversations/\(item.conversationId)/messages/\(item.messageId)/save"); version += 1 } catch { self.error = error.localizedDescription }; busy = false }
            }.disabled(busy)
        } }
    }
    @ViewBuilder private var welcomeRows: some View {
        if let page = welcome, let conversationId { Section("Welcome to the group") {
            Text(page.profile.welcome?.isEmpty == false ? page.profile.welcome! : "Make yourself at home.")
            if let rules = page.profile.rules, !rules.isEmpty { Text("Group rules").font(.headline); Text(rules) }
            if let channel = page.profile.startChannelId { Button("Start here", systemImage: "arrow.right") { onOpenMessage(channel, nil) } }
            if !page.seen { Button("Got it") { change("POST", "/groups/\(conversationId)/welcome/read") }.disabled(busy) }
            if page.canManage { Button("Edit welcome & interests") { editor = .welcome(conversationId, page) } }
        } }
    }

    @MainActor private func load() async {
        loading = true; error = nil
        do {
            if let conversationId { welcome = try await container.repo.community("/groups/\(conversationId)/welcome") }
            switch tab {
            case "Catch up": catchUp = try await container.repo.community("/catch-up")
            case "Events": let response: CommunityEvents = try await container.repo.community("/events", query: ["conversationId": conversationId]); if !Task.isCancelled { events = response.events }
            case "Reminders": let response: CommunityReminders = try await container.repo.community("/reminders"); if !Task.isCancelled { reminders = response.reminders }
            case "Scheduled": let response: CommunitySchedule = try await container.repo.community("/scheduled"); if !Task.isCancelled { scheduled = response.messages }
            case "Saved": let response: CollectionItems = try await container.repo.community("/saved", query: ["q": query, "collectionId": collectionId.isEmpty ? nil : collectionId]); let folders: SavedCollections = try await container.repo.community("/collections"); if !Task.isCancelled { saved = response.items; collections = folders.collections }
            default: break
            }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        if !Task.isCancelled { loading = false }
    }
    private func change(_ method: String, _ path: String, _ body: JSONValue? = nil) {
        guard !busy else { return }; busy = true
        Task { do { try await container.repo.changeCommunity(method, path, body); version += 1 } catch { self.error = error.localizedDescription }; busy = false }
    }
}

enum CommunityEditorTarget: Identifiable {
    case event(String, CommunityEvent?)
    case saved(CollectionItem)
    case collection(SavedCollection)
    case welcome(String, CommunityWelcome)
    case reminder(String)
    case scheduled(String, String)
    var id: String {
        switch self { case .event(let id, let event): return "event:" + (event?.id ?? id)
        case .saved(let item): return "saved:" + item.id
        case .collection(let item): return "collection:" + item.id
        case .welcome(let id, _): return "welcome:" + id
        case .reminder(let id): return "reminder:" + id
        case .scheduled(let id, _): return "scheduled:" + id }
    }
}

struct CommunityEditor: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.neu) private var colors
    let target: CommunityEditorTarget
    let onDone: () -> Void
    @State private var requestId = UUID().uuidString
    @State private var title = ""; @State private var details = ""; @State private var location = ""
    @State private var starts = Date().addingTimeInterval(3600); @State private var ends = Date().addingTimeInterval(7200); @State private var hasEnd = false
    @State private var collectionId = ""; @State private var newCollection = ""; @State private var collections: [SavedCollection] = []
    @State private var tags = ""; @State private var language = ""; @State private var channel = ""; @State private var remove = false
    @State private var error: String?; @State private var busy = false
    @State private var ready = false

    private var heading: String {
        switch target { case .event(_, let event): return event == nil ? "Create event" : "Edit event"
        case .saved: return "Collection & note"; case .collection: return "Manage collection"
        case .welcome: return "Welcome & interests"; case .reminder: return "Remind me"; case .scheduled: return "Schedule message" }
    }
    var body: some View {
        Form {
            if !ready { ProgressView("Loading…") }
            Group {
            switch target {
            case .event:
                Section { TextField("Event name", text: $title); TextField("About", text: $details, axis: .vertical).lineLimit(3...8); TextField("Where", text: $location) }
                Section { DatePicker("Starts", selection: $starts, in: Date()..., displayedComponents: [.date, .hourAndMinute]); Toggle("Add an end time", isOn: $hasEnd); if hasEnd { DatePicker("Ends", selection: $ends, in: starts..., displayedComponents: [.date, .hourAndMinute]) }; Text("Everyone sees the time in their own time zone.").font(.footnote) }
            case .saved:
                Section { Picker("Collection", selection: $collectionId) { Text("All saved").tag(""); ForEach(collections) { folder in Text(folder.name).tag(folder.id) } }; TextField("Or create a collection", text: $newCollection); TextField("Personal note", text: $details, axis: .vertical).lineLimit(3...8); Text("Only you can see these notes.").font(.footnote) }
            case .collection:
                Section { TextField("Collection name", text: $title); Toggle("Delete collection", isOn: $remove); if remove { Text("Your saved messages and notes stay in All saved.") } }
            case .welcome(_, let page):
                Section { TextField("Welcome message", text: $title, axis: .vertical).lineLimit(3...8); TextField("Group rules", text: $details, axis: .vertical).lineLimit(3...8); TextField("Interests, comma separated (up to 5)", text: $tags); Picker("Language", selection: $language) { ForEach(communityLanguages, id: \.0) { value, label in Text(label).tag(value) } }; Picker("Starting channel", selection: $channel) { Text("No starting channel").tag(""); ForEach(page.channels) { c in Text(c.title ?? "Channel").tag(c.id) } } }
            case .reminder:
                Section { Text("Get a notification linking back to this message."); timePicker }
            case .scheduled(_, let content):
                Section { Text(content); Text("This text sends even when your devices are offline.").font(.footnote); timePicker }
            }
            }.disabled(!ready || busy)
            if let error { Text(error).foregroundStyle(colors.danger); if !ready { Button("Retry") { Task { await initialize() } } } }
        }
        .scrollContentBackground(.hidden).background(colors.surface).foregroundStyle(colors.textPrimary).tint(colors.accent)
        .navigationTitle(heading).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }; ToolbarItem(placement: .confirmationAction) { Button(busy ? "Saving…" : "Save") { save() }.disabled(busy || !ready) } }
        .interactiveDismissDisabled(busy)
        .task { await initialize() }
    }
    private var timePicker: some View { VStack(alignment: .leading) { DatePicker("When", selection: $starts, in: Date()..., displayedComponents: [.date, .hourAndMinute]); Text("Your local time zone. Manage this in Catch up.").font(.footnote) } }
    @MainActor private func initialize() async {
        error = nil
        switch target {
        case .event(_, let event): if let event { title = event.title; details = event.description; location = event.location; starts = CommunityTime.date(event.startsAt); hasEnd = event.endsAt != nil; if let end = event.endsAt { ends = CommunityTime.date(end) } }
        case .saved(let item): details = item.note; collectionId = item.collectionId ?? ""; do { let response: SavedCollections = try await container.repo.community("/collections"); let existing: SavedDetails = try await container.repo.community("/saved/\(item.id)"); collections = response.collections; details = existing.note; collectionId = existing.collectionId ?? "" } catch { self.error = error.localizedDescription; return }
        case .collection(let folder): title = folder.name
        case .welcome(_, let page): title = page.profile.welcome ?? ""; details = page.profile.rules ?? ""; tags = (page.profile.tags ?? []).joined(separator: ", "); language = page.profile.language ?? ""; channel = page.profile.startChannelId ?? ""
        default: break
        }
        ready = true
    }
    private func save() {
        guard !busy else { return }; busy = true; error = nil
        Task {
            do {
                switch target {
                case .event(let conversationId, let event):
                    let body = jsonBody(["id": event == nil ? .string(requestId) : nil, "title": .string(title), "description": .string(details), "location": .string(location), "startsAt": .string(CommunityTime.wire(starts)), "endsAt": hasEnd ? .string(CommunityTime.wire(ends)) : .null])
                    try await container.repo.changeCommunity(event == nil ? "POST" : "PATCH", event.map { "/events/\($0.id)" } ?? "/groups/\(conversationId)/events", body)
                case .reminder(let messageId): try await container.repo.changeCommunity("POST", "/reminders", jsonBody(["id": .string(requestId), "messageId": .string(messageId), "dueAt": .string(CommunityTime.wire(starts))]))
                case .scheduled(let conversationId, let content): try await container.repo.changeCommunity("POST", "/scheduled", jsonBody(["id": .string(requestId), "conversationId": .string(conversationId), "content": .string(content), "sendAt": .string(CommunityTime.wire(starts))]))
                case .saved(let item):
                    var folder = collectionId
                    if !newCollection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { try await container.repo.changeCommunity("POST", "/collections", jsonBody(["id": .string(requestId), "name": .string(newCollection)])); folder = requestId }
                    try await container.repo.changeCommunity("PUT", "/saved/\(item.messageId)", jsonBody(["collectionId": folder.isEmpty ? .null : .string(folder), "note": .string(details)]))
                case .collection(let folder): try await container.repo.changeCommunity(remove ? "DELETE" : "PATCH", "/collections/\(folder.id)", remove ? nil : jsonBody(["name": .string(title)]))
                case .welcome(let id, _): try await container.repo.changeCommunity("PUT", "/groups/\(id)/welcome", jsonBody(["welcome": .string(title), "rules": .string(details), "tags": .array(tags.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }), "language": .string(language), "startChannelId": channel.isEmpty ? .null : .string(channel)]))
                }
                onDone(); dismiss()
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

let communityLanguages = [("", "Any language"), ("en", "English"), ("ar", "Arabic"), ("ur", "Urdu"), ("hi", "Hindi"), ("es", "Spanish"), ("fr", "French"), ("de", "German"), ("pt", "Portuguese")]
