import SwiftUI

private let systemNoticeKinds: Set<String> = [
    "account_suspended", "account_restored", "new_sign_in", "badge_granted", "badge_revoked",
    "group_removed", "group_banned", "group_unbanned", "report_reviewed", "bug_updated",
]

/// Event copy comes from its snapshot, not from the group's current badge or name.
struct NotificationCopy {
    let title: String
    let body: String
    let isPlace: Bool

    init?(_ entry: NotificationEntry) {
        if systemNoticeKinds.contains(entry.kind) {
            title = entry.text("title") ?? "Account update"
            body = entry.text("body") ?? "Tap to view details."
            isPlace = false
            return
        }
        let group = entry.text("title") ?? "a group"
        let badge = entry.text("badge") ?? BadgeKind.verified
        let actor = entry.actor?.label ?? "Someone"
        isPlace = entry.kind != "follow" && entry.kind != "follow_back"

        switch entry.kind {
        case "group_verified":
            title = badge == BadgeKind.partner ? "\(group) is a yappy partner" : "\(group) is \(badge)"
            body = "The badge is on the group now. Admins can affiliate members from the group page."
        case "group_verification_declined":
            title = "\(group) is no longer \(badge)"
            body = "Its affiliates lose the badge with it. You can ask again from group settings."
        case "affiliate_granted":
            title = "\(group) made you an affiliate"
            body = "Its badge can sit beside your name — turn it on in Settings."
        case "affiliate_revoked":
            title = "\(group) removed your affiliate status"
            body = "Its badge no longer appears beside your name."
        case "role_granted":
            title = "You're \(entry.text("role") ?? "an admin") of \(group)"
            body = "\(actor) gave you the role."
        case "follow":
            title = "\(actor) followed you"
            body = "Tap to see their profile."
        case "follow_back":
            title = "\(actor) followed you back"
            body = "You follow each other now."
        default:
            return nil
        }
    }
}

/// Uses the inbox's normal row. Only successful grants add a seal to the avatar.
struct NotificationRow: View {
    @Environment(\.neu) private var colors
    let entry: NotificationEntry
    let onOpenGroup: (String) -> Void
    let onOpenProfile: (String) -> Void
    @State private var detailsOpen = false

    private var unread: Bool { entry.readAt == nil }
    private var systemNotice: Bool { systemNoticeKinds.contains(entry.kind) }
    private var grantBadge: String? {
        let badge = entry.text("badge") ?? BadgeKind.verified
        guard entry.kind == "group_verified",
              badge == BadgeKind.verified || badge == BadgeKind.partner
        else { return nil }
        return badge
    }

    var body: some View {
        if let copy = NotificationCopy(entry) {
            HStack(spacing: 10) {
                if unread {
                    Capsule()
                        .fill(colors.accent)
                        .frame(width: 2, height: 36)
                }
                if systemNotice {
                    systemIcon
                } else {
                    Avatar(
                        url: copy.isPlace ? entry.text("avatarUrl") : entry.actor?.avatarUrl,
                        name: copy.isPlace ? entry.text("title") : entry.actor?.label,
                        id: entry.targetId ?? entry.id,
                        size: 36,
                        shape: copy.isPlace ? .place : .person
                    )
                    .overlay(alignment: .bottomTrailing) {
                        if let badge = grantBadge {
                            BadgeMark(badge: badge, size: 17)
                                .padding(2)
                                .background(unread ? colors.accentSoft : colors.surface, in: Circle())
                                .offset(x: 4, y: 4)
                        }
                    }
                    // The title already names the subject and event for VoiceOver.
                    .accessibilityHidden(true)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(copy.title)
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(2)
                    Text(copy.body)
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textSecondary)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)

                Text(YappyTime.relative(entry.createdAt))
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .fixedSize()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(unread ? colors.accentSoft : Color.clear, in: NeuShape(radius: Neu.cornerMedium))
            .softTap(action: openTarget)
            .accessibilityElement(children: .combine)
            .accessibilityValue(unread ? "Unread" : "Read")
            .accessibilityAction { openTarget() }
            .sheet(isPresented: $detailsOpen) {
                NotificationDetailsView(
                    kind: entry.kind, title: copy.title, bodyText: copy.body,
                    detail: entry.text("detail"), until: entry.text("until"), supportUrl: entry.text("supportUrl"),
                    onDismiss: { detailsOpen = false }
                )
            }
        }
    }

    private func openTarget() {
        if systemNotice {
            detailsOpen = true
            return
        }
        guard let id = entry.targetId else { return }
        switch entry.targetType {
        case "conversation": onOpenGroup(id)
        case "user": onOpenProfile(id)
        default: break
        }
    }

    private var systemIcon: some View {
        SystemNoticeIcon(kind: entry.kind)
    }
}

private struct SystemNoticeIcon: View {
    @Environment(\.neu) private var colors
    let kind: String
    var size: CGFloat = 36

    var body: some View {
        let danger = kind == "account_suspended" || kind == "group_banned"
        let tint = danger ? colors.danger : (kind == "new_sign_in" ? colors.warning : colors.accent)
        let symbol: String
        switch kind {
        case "account_suspended", "group_banned": symbol = "nosign"
        case "new_sign_in": symbol = "laptopcomputer.and.iphone"
        case "badge_granted", "badge_revoked": symbol = "rosette"
        case "group_removed": symbol = "person.crop.circle.badge.minus"
        case "report_reviewed": symbol = "flag"
        case "bug_updated": symbol = "ladybug"
        default: symbol = "shield"
        }
        return Image(systemName: symbol)
            .font(.system(size: size * 0.58))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.12), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Shared by inbox history and the immediate notice shown when a session ends.
struct NotificationDetailsView: View {
    @Environment(\.neu) private var colors
    @Environment(\.openURL) private var openURL
    let kind: String
    let title: String
    let bodyText: String
    let detail: String?
    let until: String?
    var supportUrl: String? = nil
    let onDismiss: () -> Void

    private var deadline: Date? { YappyTime.parse(until) }
    private var explanation: String? {
        // Older snapshots kept the deadline in the first paragraph too.
        guard deadline != nil, let detail, detail.hasPrefix("Suspended until ") else { return detail }
        return detail.components(separatedBy: "\n\n").dropFirst().joined(separator: "\n\n")
    }

    var body: some View {
        VStack(spacing: 20) {
            HStack(spacing: 12) {
                SystemNoticeIcon(kind: kind, size: 44)
                Text(title)
                    .font(YappyFont.headlineSmall)
                    .foregroundStyle(colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                NeuIconButton(systemName: "xmark", label: "Close", size: 40, action: onDismiss)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    NeuSurface(state: .pressed, elevation: 3) {
                        VStack(alignment: .leading, spacing: 6) {
                            if kind == "account_suspended" {
                                Text("Reason").font(YappyFont.labelMedium).foregroundStyle(colors.danger)
                            }
                            Text(bodyText)
                                .font(YappyFont.bodyLarge).foregroundStyle(colors.textPrimary)
                                .textSelection(.enabled)
                        }
                    }
                    if let deadline {
                        HStack(spacing: 12) {
                            Image(systemName: "clock").font(.system(size: 22)).foregroundStyle(colors.accent)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(deadline > Date() ? "Scheduled to end" : "Ended")
                                    .font(YappyFont.labelMedium).foregroundStyle(colors.textTertiary)
                                Text(formattedDeadline(deadline))
                                    .font(YappyFont.labelLarge).foregroundStyle(colors.textPrimary)
                            }
                        }
                    }
                    if let explanation, !explanation.isEmpty {
                        Text(explanation)
                            .font(YappyFont.bodyMedium).foregroundStyle(colors.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
                .padding(3)
            }
            VStack(spacing: 10) {
                if kind == "account_suspended" {
                    NeuButton(accent: true, action: { openURL(SupportLinks.url(appeal: true, source: supportUrl)) }) {
                        Text("Appeal suspension").font(YappyFont.labelLarge).foregroundStyle(colors.onAccent)
                    }
                }
                NeuButton(accent: kind != "account_suspended", action: onDismiss) {
                    Text("Got it").font(YappyFont.labelLarge)
                        .foregroundStyle(kind == "account_suspended" ? colors.textPrimary : colors.onAccent)
                }
            }
        }
        .padding(20)
        .padding(.top, 8)
        .presentationDetents(kind == "account_suspended" ? [.large] : [.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(colors.surface)
    }

    private func formattedDeadline(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.dateFormat = "d MMM yyyy · h:mm a z"
        return formatter.string(from: date)
    }
}

#if DEBUG
struct NotificationRow_Previews: PreviewProvider {
    static var previews: some View {
        Group {
            samples(colors: .light).previewDisplayName("Notifications · light")
            samples(colors: .dark).previewDisplayName("Notifications · dark")
        }
        .previewLayout(.fixed(width: 378, height: 900))
    }

    private static func samples(colors: NeuColors) -> some View {
        let now = YappyTime.now()
        let grant = NotificationEntry(
            id: "preview-grant", kind: "group_verified", targetType: "conversation", targetId: "preview-group",
            data: ["title": .string("revolving door"), "badge": .string("verified")], createdAt: now
        )
        var role = grant
        role.kind = "role_granted"
        var read = grant
        read.readAt = now
        read.data["title"] = .string("Pittsburgh / design community and creative friends")
        var revoked = grant
        revoked.kind = "group_verification_declined"
        var partner = grant
        partner.data["badge"] = .string("partner")
        let suspension = NotificationEntry(
            id: "preview-suspension", kind: "account_suspended",
            data: [
                "title": .string("Your account was suspended"),
                "body": .string("Repeated harassment after a warning."),
                "until": .string("2026-09-13T12:00:00.000Z"),
                "detail": .string("Suspended until Sun, 13 Sep 2026 12:00:00 GMT.\n\nWhile suspended, you cannot sign in or post. Your messages and groups have not been deleted."),
            ], createdAt: now
        )
        let signIn = NotificationEntry(
            id: "preview-sign-in", kind: "new_sign_in",
            data: [
                "title": .string("New sign-in to your account"),
                "body": .string("Signed in from iPhone. If this was you, no action is needed."),
                "detail": .string("If this was not you, change your password in Settings to sign out other devices."),
            ], createdAt: now
        )

        return VStack(spacing: 0) {
            HStack(spacing: 12) {
                NeuIconButton(systemName: "chevron.left", label: "Back", action: {})
                Text("Notifications").font(YappyFont.headlineSmall).foregroundStyle(colors.textPrimary)
                Spacer()
            }
            .padding(16)
            VStack(spacing: 4) {
                NotificationRow(entry: role, onOpenGroup: { _ in }, onOpenProfile: { _ in })
                NotificationRow(entry: grant, onOpenGroup: { _ in }, onOpenProfile: { _ in })
                NotificationRow(entry: suspension, onOpenGroup: { _ in }, onOpenProfile: { _ in })
                NotificationRow(entry: signIn, onOpenGroup: { _ in }, onOpenProfile: { _ in })
                NotificationRow(entry: read, onOpenGroup: { _ in }, onOpenProfile: { _ in })
                NotificationRow(entry: partner, onOpenGroup: { _ in }, onOpenProfile: { _ in })
                NotificationRow(entry: revoked, onOpenGroup: { _ in }, onOpenProfile: { _ in })
            }
            .padding(.horizontal, 12)
            Spacer(minLength: 0)
        }
        .background(colors.surface)
        .environment(\.neu, colors)
    }
}
#endif
