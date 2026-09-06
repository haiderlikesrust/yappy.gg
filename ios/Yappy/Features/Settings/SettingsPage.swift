import SwiftUI

enum SettingsPage: String, CaseIterable, Hashable, Identifiable {
    case account, privacy, notifications, appearance, storage, devices

    var id: Self { self }
    var title: String {
        switch self {
        case .account: return "Account"
        case .privacy: return "Privacy & safety"
        case .notifications: return "Notifications"
        case .appearance: return "Appearance"
        case .storage: return "Storage"
        case .devices: return "Devices"
        }
    }
    var symbol: String {
        switch self {
        case .account: return "person.crop.circle"
        case .privacy: return "hand.raised"
        case .notifications: return "bell.badge"
        case .appearance: return "paintpalette"
        case .storage: return "internaldrive"
        case .devices: return "iphone.and.arrow.forward"
        }
    }
    var subtitle: String {
        switch self {
        case .account: return "Profile, status, username and password"
        case .privacy: return "Who can reach you, blocked accounts and app lock"
        case .notifications: return "Messages, sounds and quiet hours"
        case .appearance: return "Theme, colors and text size"
        case .storage: return "Cached photos, files and device space"
        case .devices: return "Where you're signed in and active sessions"
        }
    }
    func contains(section: String) -> Bool {
        switch self {
        case .account: return ["Status", "Affiliation", "Account"].contains(section)
        case .privacy: return section == "Privacy"
        case .devices: return section == "Active sessions"
        default: return section == title
        }
    }
}
