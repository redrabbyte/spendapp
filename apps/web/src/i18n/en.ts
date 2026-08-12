import type { Message } from './index';

/**
 * The source-of-truth catalogue. Its keys type every other language, so a
 * German file that misses one or misspells one fails to compile.
 *
 * Keys are namespaced by where they appear. Prose is kept whole rather than
 * assembled from fragments — a sentence split across three keys cannot be
 * translated into a language that orders its clauses differently.
 */
export const en = {
  // --- settings -----------------------------------------------------------
  'settings.title': 'Settings',
  'settings.close': 'Close',
  'settings.appearance': 'Appearance',
  'settings.theme.system': 'system',
  'settings.theme.light': 'light',
  'settings.theme.dark': 'dark',
  'settings.language': 'Language',
  'settings.currency': 'My default currency',
  'settings.currency.hint': 'Pre-selected when you create a new group.',
  'settings.timezone': 'Display timezone',
  'settings.timezone.device': 'device ({zone})',
  'settings.timezone.choose': 'choose…',
  'settings.timezone.filter': 'filter zones…',
  'settings.timezone.hint': 'Times are stored in UTC and shown in this zone.',
  'settings.notifications': 'Notifications',

  // --- account ------------------------------------------------------------
  'account.title': 'Account',
  'account.displayName': 'Your name',
  'account.displayName.hint': 'This is what everyone in your groups sees.',
  'account.username': 'Username',
  'account.username.hint': 'What you log in with. Changing it does not affect your data.',
  'account.save': 'Save changes',
  'account.saving': 'Saving…',
  'account.saved': 'Saved.',

  // --- app shell ----------------------------------------------------------
  'sync.pending': 'Not synced yet — this change was made offline and will upload when you are back online.',

  'invalid.summary': {
    one: '{count} entry does not add up and is left out of every total here.',
    other: '{count} entries do not add up and are left out of every total here.',
  },
  'invalid.item': 'last written by {author} — {reason}',
  'invalid.hint': 'Ask them to open it and save it again. Until then the group’s totals are short by whatever it held.',

  'push.unavailable': 'Push is not configured on this server (no VAPID keys).',
  'push.unsupported': 'Notifications need an installed app on iOS: share → “Add to Home Screen”.',
  'push.label': 'Notifications:',
  'push.blocked': 'blocked in browser settings',
  'push.on': 'on — turn off',
  'push.off': 'off — turn on',
  'push.prompt': 'Get notified when someone adds an expense or pays you back?',
  'push.prompt.enable': 'Enable',
  'push.prompt.later': 'Not now',

  'gap.title': 'Showing only part of this group.',
  'gap.expenses': 'Entries written before you joined are not listed here.',
  'gap.balances': 'These balances cover only what you can read. Your own position is exact — you were in none of the earlier splits — but debts between other people from before you joined are not included.',
  'gap.charts': 'These charts cover only what you can read, so totals and categories start from when you joined.',
  'gap.activity': 'The history starts when you joined. Earlier entries, comments and receipts are not shown.',
  'gap.members': 'You joined partway through, so you cannot pass this group’s full history on to anyone new.',

  // --- unlocking and passwords --------------------------------------------
  'unlock.title': 'Unlock this device',
  'unlock.explain': 'You are signed in as {username}, but this device has no keys. Your password is the only thing that can rebuild them — the server cannot.',
  'unlock.password': 'Password',
  'unlock.submit': 'Unlock',
  'unlock.working': 'Unlocking…',
  'unlock.logout': 'Log out instead',

  'password.title': 'Password',
  'password.change': 'Change password',
  'password.current': 'Current password',
  'password.new': 'New password (min. 10 characters)',
  'password.save': 'Save new password',
  'password.saving': 'Re-keying…',
  'password.cancel': 'Cancel',
  'password.changed': 'Password changed. Your other devices will ask for the new one.',
  'password.noReset': 'There is no reset — the server cannot read your data, so it cannot restore access either.',

  'install.title': 'Install SpendApp?',
  'install.ios': 'Share → Add to Home Screen',
  'install.why': 'Installed, it opens straight from your home screen and keeps working without a connection — add expenses offline and they sync when you are back.',
  'install.manual': 'Tap Share (the square with an arrow) at the bottom of the browser, then “Add to Home Screen”.',
  'install.gotIt': 'Got it',
  'install.install': 'Install',
  'install.later': 'Not now',

  // --- groups list --------------------------------------------------------
  'groups.title': 'Your groups',
  'groups.loading': 'Loading…',
  'groups.empty': 'No groups yet — create one below.',
  'groups.memberCount': { one: '{count} member', other: '{count} members' },
  'groups.new': 'New group',
  'groups.new.placeholder': 'e.g. Flat 12b',
  'groups.currency': 'Currency',
  'groups.create': 'Create',
  'groups.joinInPerson': 'Join a group in person',
  'groups.import': 'Import from CSV',

  // --- login and registration ---------------------------------------------
  'login.title': 'Log in',
  'login.register': 'Create account',
  'login.displayName': 'Your name',
  'login.username': 'Username',
  'login.password': 'Password',
  'login.password.new': 'Password (min. 10 characters)',
  'login.working': 'Working…',
  'login.deriving': 'Securing your account — this takes a moment on a phone.',
  'login.toRegister': 'New here? Create an account',
  'login.toLogin': 'Have an account? Log in',
  'login.policy': 'Privacy policy',
  'login.policy.loading': 'Loading the privacy policy…',
  'login.policy.failed': 'Could not load the privacy policy ({reason}) — registration needs it, so try again.',
  'login.policy.accept': 'I have read and accept the privacy policy.',
  'login.policy.placeholder': 'This server has no privacy policy installed, so the text below is a placeholder. Whoever runs it needs to put the real one in place before inviting anyone.',
  'login.noReset': 'Your data is encrypted with this password and the server cannot read it, so there is no reset. Use a password manager. If you forget it, someone else in your groups can let a new account back in — but anything you are the only member of is gone.',
  'privacy.changed.title': 'The privacy policy has changed',
  'privacy.changed.again': 'Please read the current version and accept it to carry on.',
  'privacy.changed.never': 'Please read it and accept it to carry on — your account predates this step.',
  'privacy.accept': 'I accept',
  'privacy.accepting': 'Saving…',
  'privacy.logout': 'Log out instead',

  // --- errors this app raises itself ---------------------------------------
  'app.keysLocked': 'Your keys are locked — log in again to create a group.',
  'app.noGroupKeys': 'You hold no keys for this group yet.',
  'app.nobodyToRotateTo': 'Nobody left in this group has a key to rotate to.',
  'app.noKeyYet': 'No key for this group yet — wait for it to sync, then try again.',
  'app.missingKeyParams': 'Could not start signing in. Check your connection and try again.',
  'app.noStoredKeys': 'This account has no stored keys.',
  'app.wrongPassword': 'Wrong password — that did not unlock your data.',
  'app.copyFailed': 'Could not copy — select the link and copy it by hand.',
  'app.expenseMissing': 'That expense is not here any more.',
  'app.samePayer': 'The payer and the receiver have to be different people.',
  'app.badRate': 'Those amounts give a rate that cannot be right.',
  'app.pickTwoCurrencies': 'Pick two different currencies.',
  'app.invalidRate': 'Enter a valid rate.',
  'app.badPercentage': 'Percentages have to be numbers, and cannot be negative.',
  'app.badShares': 'Shares have to be whole numbers.',
  'app.paidSum': 'The amounts paid add up to {paid}, but the expense is {total}.',
  'app.needRate': 'Enter a valid conversion rate to {currency}.',
  'app.paymentAmount': 'A payment has to be a positive amount.',
  'app.paymentSelf': 'A payment cannot go from someone to themselves.',
  'app.settledAmount': 'The settled amount is not a valid number.',
  'app.importFailed': 'Could not {step}: {reason}',

  // Why an entry was refused. Stored with the entry, so these are looked up
  // when it is shown rather than written when it was checked.
  'split.no_participants': 'nobody is included',
  'split.invalid_weight': 'a share is not a valid number',
  'split.invalid_total': 'the total is not a valid number',
  'split.weights_sum_zero': 'every share is zero',
  'split.duplicate_participant': 'somebody appears twice',
  'split.exact_sum_mismatch': 'the exact amounts do not add up to the total',
  'split.percent_sum_mismatch': 'the percentages do not add up to 100%',
  'split.invalid_shares': 'a share is not a whole number',
  'split.no_splits': 'it splits between nobody',
  'split.invalid_amount': 'the amount is not a valid number',
  'split.invalid_paid': 'an amount paid is not a valid number',
  'split.invalid_owed': 'an amount owed is not a valid number',
  'split.paid_sum_mismatch': 'the amounts paid do not add up to the total',
  'split.owed_sum_mismatch': 'the amounts owed do not add up to the total',

  // --- joining -------------------------------------------------------------
  'join.title': 'Join a group in person',
  'join.explain': 'Show this to someone already in the group and let them scan it. They can add you on the spot — no link, and nothing to read out.',
  'join.locked': 'Your keys are locked on this device. Log in again and the code will appear.',
  'join.safe': 'Safe to show anyone: it holds your name and a public key, never a password or a group’s contents.',
  'join.waiting': 'The group appears here by itself once they have added you.',
  'join.preparing': 'Preparing your code…',
  'join.back': 'Back to your groups',
  'join.codeLabel': 'Your join code',

  'invite.share': 'Share this link (valid 14 days):',
  'invite.copy': 'Copy link',
  'invite.shareAction': 'Share link',
  'invite.copied': 'Copied',
  'invite.copyFailed': 'Could not copy — select the link and copy it by hand',
  'invite.shareFailed': 'Sharing failed',
  'invite.shareText': 'Join my group on SpendApp',

  // --- categories ----------------------------------------------------------
  // The stored value is a stable key ('food'), sealed inside the expense, so
  // these are labels only — nothing here changes what is written down.
  'category.food': 'food',
  'category.groceries': 'groceries',
  'category.transport': 'transport',
  'category.housing': 'housing',
  'category.utilities': 'utilities',
  'category.entertainment': 'entertainment',
  'category.travel': 'travel',
  'category.health': 'health',
  'category.shopping': 'shopping',
  'category.other': 'other',
  'category.folded': 'other (folded)',

  // --- charts --------------------------------------------------------------
  'charts.range.all': 'all time',
  'charts.range.30': '30 days',
  'charts.range.90': '90 days',
  'charts.range.ytd': 'this year',
  'charts.view': 'view:',
  'charts.perCurrency': 'per currency',
  'charts.allIn': 'all in {currency}',
  'charts.empty': 'No expenses in this range.',
  'charts.skipped': {
    one: '{count} expense skipped — no cached rate for its currency. Conversion is display-only; stored data is untouched.',
    other: '{count} expenses skipped — no cached rate for their currency. Conversion is display-only; stored data is untouched.',
  },
  'charts.perPerson': 'Per person ({currency})',
  'charts.spending': 'Spending',
  'charts.spending.hint': 'paid out of pocket',
  'charts.share': 'Share',
  'charts.share.hint': 'what they consumed',
  'charts.byCategory': 'By category',
  'charts.perMonth': 'Per month ({currency})',

  // --- the expense editor --------------------------------------------------
  'editor.what': 'What was it?',
  // A worked example of the format, so it follows the reader's decimal mark.
  // `parseToMinor` accepts either, which is what makes translating it safe.
  'editor.amount': '0.00',
  'editor.totalIsSum': 'total = sum of payer amounts',
  'editor.rate': 'rate',
  'editor.ratePrefilled': '(prefilled from today’s rate; editable)',
  'editor.rateOffline': '(no fx suggestion offline; enter manually)',
  'editor.convertTo': 'Convert amounts to',
  'editor.chooseUnit': 'choose unit…',
  'editor.convertAt': 'at 1 {currency} =',
  'editor.convert': 'Convert',
  'editor.paidBy': 'Paid by',
  'editor.singlePayer': 'single payer',
  'editor.multiplePayers': 'multiple payers',
  'editor.totalOfPayers': 'Total is the sum of these — {amount} {currency}.',
  'editor.split': 'Split',
  'editor.mode.equal': 'equally',
  'editor.mode.exact': 'exact amounts',
  'editor.mode.percent': 'percentages',
  'editor.mode.shares': 'shares',
  'editor.percentRemaining': '{percent}% remaining',
  'editor.percentOver': '{percent}% over',
  'editor.balanced': 'balanced',
  'editor.amountRemaining': '{amount} {currency} remaining',
  'editor.amountOver': '{amount} {currency} over',
  'editor.totalFromAmounts': 'total {amount} {currency} (from amounts)',
  'editor.paid': 'paid',
  'editor.owes': 'owes',
  'editor.note': 'Note (optional)',
  'editor.save': 'Save changes',
  'editor.add': 'Add expense',
  'editor.cancel': 'cancel',

  // --- balances, payments and bulk conversion ------------------------------
  'balances.settled': 'All settled up.',
  'balances.suggested': 'Suggested settlements',
  'balances.record': 'record',
  'balances.recordPayment': 'Record a payment',
  'balances.payments': 'Payments',
  'balances.paymentLine': '{date}: {from} paid {to} {amount}',
  'balances.settles': '(settles {amount} @ {rate})',
  'balances.delete': 'delete',
  'balances.paid': 'paid',
  'balances.crossCurrency': 'paid in a different currency than the debt',
  'balances.settlesLabel': 'settles',
  'balances.ofDebt': '{currency} of debt',
  'balances.ofDebtOffline': '{currency} of debt (no fx suggestion available offline)',
  'balances.paymentNote': 'Note (optional, e.g. ‘sent via PayPal’)',
  'balances.submitPayment': 'Record payment',
  'balances.convertOld': 'Convert old entries',
  'balances.from': 'from…',
  'balances.oneRate': 'one rate for all',
  'balances.atRate': 'at rate',
  'balances.convert': 'Convert',
  'balances.convertCount': {
    one: 'Convert {count} entry',
    other: 'Convert {count} entries',
  },
  'balances.savedRateNote':
    'Uses each entry’s saved rate when converting to {currency}; otherwise today’s cached rate.',
  'balances.converted': {
    one: 'Converted {count} entry {from}→{to} — revertable in history.',
    other: 'Converted {count} entries {from}→{to} — revertable in history.',
  },
  'balances.convertSkipped': {
    one: 'Skipped {count} with no rate available.',
    other: 'Skipped {count} with no rate available.',
  },

  // --- the app shell -------------------------------------------------------
  'shell.settings': 'Settings',
  'shell.logout': 'Log out',
  'shell.loggingOut': 'Logging out and clearing this device…',
  'shell.offline': 'offline — changes will sync later',
  'shell.build': 'build {date} UTC',
  'shell.installAsApp': 'Install as an app',

  'footer.copyright': '© {year} {owner}',

  // --- taking your data with you, and leaving -------------------------------
  'data.title': 'My data',
  'data.download': 'Download my data',
  'data.working': 'Working…',
  'data.collecting': 'Collecting…',
  'data.receipts': 'Receipts {done}/{total}…',
  'data.packing': 'Packing…',
  'data.downloaded': 'Downloaded.',
  'data.explain':
    'A ZIP with everything: your account, and every expense, payment, comment and receipt, decrypted here on this device because the server cannot read them.',
  'delete.zone': 'Danger zone',
  'delete.open': 'Delete my account',
  'delete.title': 'Delete your account',
  'delete.warning':
    'This cannot be undone. Your login and everything that identifies you are erased. Your name stays on the expenses and payments you shared with other people, because those are their records of money owed too.',
  'delete.downloadFirst': 'Download your data first if you want a copy — after this there is no way to get one.',
  'delete.lastMember': {
    one: 'You are the last member of this group, so it will be destroyed along with every expense, receipt and comment in it:',
    other: 'You are the last member of these groups, so they will be destroyed along with every expense, receipt and comment in them:',
  },
  'delete.orphaning':
    'You are the only person who can read part of the history in {groups}. Those entries are lost to everyone once you are gone, and nothing can bring them back.',
  'delete.promoting':
    'You are the only admin of {groups} — the longest-standing member takes over so joins can still be approved.',
  'delete.typePassword': 'Type your password to confirm',
  'delete.deleting': 'Deleting…',
  'delete.cancel': 'Cancel',

  // --- a group and its expense list ----------------------------------------
  'group.formerMember': '(former member)',
  'group.loading': 'Loading…',
  'group.notFound': 'Group not found (or not synced yet).',
  'group.csv': 'CSV',
  'group.import': 'Import',
  'group.inviteLink': 'Invite link',
  'group.inviteAll': 'Invite, sharing everything',
  'group.inviteAllNote': 'They read the group from the beginning, like everyone else in it.',
  'group.inviteToday': 'Invite, from today only',
  'group.inviteTodayNote':
    'Nothing recorded so far will be readable to them — not the amounts, not who owed whom. Their own balance stays exact, but they see a partial picture of everyone else’s, and they cannot pass the earlier history on to anyone.',
  'group.inviteScopedWarning':
    'This link shares nothing from before it is accepted, and accepting it rotates the group key.',
  'group.tab.expenses': 'Expenses',
  'group.tab.balances': 'Balances',
  'group.tab.charts': 'Charts',
  'group.tab.activity': 'Activity',
  'group.tab.members': 'Members',
  'group.search': 'Search expenses',
  'group.clearSearch': 'Clear search',
  'group.noExpenses': 'No expenses yet.',
  'group.noMatches': 'Nothing matches “{query}”.',
  'group.expenseLine': '{date} · {category} · paid by {names}',

  // --- one expense ---------------------------------------------------------
  'expense.line': '{date} · {category}',
  'expense.gone': 'This expense is no longer here.',
  'expense.backToGroup': '← back to group',
  'expense.noRate': 'No saved or cached rate to convert {from} → {to}.',
  'expense.convertTo': 'convert to {currency}',
  'expense.convertToAt': 'convert to {currency} @ {rate}',
  'expense.photos': 'Photos',
  'expense.edit': 'edit',
  'expense.closeEditor': 'close editor',
  'expense.delete': 'delete',
  'expense.comments': 'Comments',
  'expense.noComments': 'No comments yet.',
  'expense.unreadableComment': 'Cannot be read on this device.',
  'expense.addComment': 'Add a comment…',
  'expense.post': 'Post',
  'expense.history': 'History',

  // --- the activity feed ---------------------------------------------------
  // Each line reads "<name> <phrase>", so the phrase carries the verb and a
  // language is free to put it where it belongs.
  'activity.empty': 'Nothing has happened yet.',
  'activity.noHistory': 'No history synced yet.',
  'activity.current': '(current)',
  'activity.restore': 'restore',
  'activity.revertTo': 'revert to this',
  'activity.revertImport': 'revert import',
  'activity.confirmRevertImport': {
    one: 'Delete the {count} entry this import created?',
    other: 'Delete the {count} entries this import created?',
  },
  'activity.what': '“{description}” ({amount})',
  'activity.anExpense': 'an expense',
  'activity.aMember': 'a member',
  'activity.wasNamed': '— “{description}”',
  'activity.group.created': 'created the group',
  'activity.member.joined': 'joined the group',
  'activity.expense.created': 'added {what}',
  'activity.expense.updated': 'edited {what}',
  'activity.expense.restored': 'restored {what}',
  'activity.expense.deleted': 'deleted an expense',
  'activity.payment.created': 'recorded a payment',
  'activity.payment.updated': 'edited a payment',
  'activity.payment.deleted': 'deleted a payment',
  'activity.member.added': 'added {name}',
  'activity.member.claimed': 'took over {name}',
  'activity.import.created': {
    one: 'imported {count} entry from {source}',
    other: 'imported {count} entries from {source}',
  },
  'activity.import.csv': 'a CSV',
  'activity.import.reverted': 'reverted an import',

  // --- CSV import ----------------------------------------------------------
  'import.title': 'Import from CSV',
  'import.close': 'Close',
  'import.explain': 'A SpendApp export or a Splitwise group export — whichever it is gets detected automatically.',
  'import.unrecognised': 'This is neither a SpendApp export nor a Splitwise one.',
  'import.summary': {
    one: '{format} — {count} expense',
    other: '{format} — {count} expenses',
  },
  'import.summaryPayments': {
    one: ', {count} payment',
    other: ', {count} payments',
  },
  'import.summaryTotal': '({total})',
  'import.formatSplitwise': 'Splitwise export',
  'import.formatSpendapp': 'SpendApp export',
  'import.groupName': 'Group name',
  // The name a group gets when the file gives nothing to go on.
  'import.defaultGroupName': 'Imported group',
  'import.whichAreYou': 'Which one are you?',
  'import.choose': 'Choose…',
  'import.othersArePlaceholders':
    'The others are added as members without accounts. Send them an invite link and they can claim their name.',
  'import.whoIsWho': 'Who is who?',
  'import.skip': 'Skip',
  'import.willBeSkipped': 'Entries involving {names} will be skipped.',
  'import.warnings': {
    one: '{count} row needs a second look',
    other: '{count} rows need a second look',
  },
  'import.run': {
    one: 'Import {count} entry',
    other: 'Import {count} entries',
  },
  'import.running': 'Importing…',
  'import.partial': 'Imported {imported}, skipped {skipped}.',
  // The two steps an import can fail at, read back as "Could not <step>: …".
  'import.step.createGroup': 'create the group',
  'import.step.addMember': 'add “{name}”',
  // Why a row could not be taken as written.
  'import.warning.unrecognised_currency': '{row}: unrecognised currency “{currency}” — skipped',
  'import.warning.amounts_do_not_cancel': '{row}: the per-person amounts do not cancel out — skipped',
  'import.warning.payment_too_many_people': '{row}: payment with more than two people — skipped',
  'import.warning.nobody_paid': '{row}: nobody paid — skipped',
  'import.warning.several_payers': '{row}: several payers — split reconstructed proportionally',
  'import.warning.split_totals_mismatch': '{row}: split totals do not match the amount — check after importing',

  // --- receipts ------------------------------------------------------------
  // Deliberately just the verb: it sits beside the currency, and the icon and
  // the small print over the camera say what is being scanned.
  'receiptScan.start': 'Scan',
  'receiptScan.beta': 'beta',
  'receiptScan.explain':
    'Fills in the total and the date from the code printed on Austrian and German till receipts. The camera image is read on this device and never uploaded.',
  'receiptScan.limits':
    'Receipts from other countries, and handwritten ones, carry no such code — those you still fill in yourself.',
  'receiptScan.filled': 'Took {amount} and the date from the receipt. Check them against the paper before saving.',
  'receiptScan.noAmount': 'That is a zero or refund receipt, so only the date was filled in.',
  'receiptScan.unknown': 'That is not an Austrian or German receipt code.',

  'receipt.alt': 'receipt',
  'receipt.undecryptable': 'can’t decrypt',
  'receipt.camera': 'camera',
  'receipt.upload': 'upload',
  'receipt.delete': 'Delete photo',

  // --- the members tab -----------------------------------------------------
  'members.remove': 'Remove',
  'members.removeLabel': 'Remove {name}',
  'members.removeConfirm': 'Remove {name}?',
  'members.cancel': 'Cancel',
  'members.someone': 'someone',
  'members.noKeyYet': 'No key on this account yet — they must log in once before they can be given the group.',
  'members.checkByVoice': 'Check by voice:',
  'members.waiting': 'Waiting for approval ({count})',
  'members.wantsToTakeOver': 'wants to take over {name}',
  'members.aPlaceholder': 'a placeholder',
  'members.approve': 'Approve',
  'members.approveAsk': 'Read the digits out first. Approving hands over the keys to everything this group has recorded.',
  'members.approveConfirm': 'The digits match',
  'members.approveCancel': 'Not yet',
  'members.decline': 'Decline',
  'members.queueNote':
    'The code is derived from their own device, so a stranger who intercepted the link reads out different digits. Declining stops that account asking again — you can take it back here for the next 30 days.',
  'members.declined': 'Declined ({count})',
  'members.declinedOn': 'declined {date}',
  'members.letThemIn': 'Let them in',
  'members.declinedNote':
    'They cannot ask again themselves, so this is the only way back in for them. Declines disappear from here after 30 days.',
  'members.addInPerson': 'Add someone in person',
  'members.registered': 'Registered users',
  'members.admin': 'admin',
  'members.you': 'you',
  'members.makeAdmin': 'Make admin',
  'members.removeAdmin': 'Remove admin',
  'members.takenOver': 'Names taken over',
  'members.nowCountsAs': 'everything recorded against this name now counts as {name}',
  'members.undo': 'Undo',
  'members.undoNote':
    'Undo gives the name back its own entries and leaves the person who took it in the group as themselves. It is how a wrong pick gets fixed — the name is claimable again afterwards.',
  'members.notSignedUp': 'Not signed up yet',
  'members.noPlaceholders': 'Nobody yet. Add people here to split expenses with them before they have an account.',
  'members.unclaimed': 'unclaimed',
  'members.namePlaceholder': 'Name',
  'members.add': 'Add',
  'members.inviteNote':
    'When they sign up, send them an invite link — they can pick their name and take over the entries already recorded against it.',
  'members.leaveTitle': 'Leave this group',
  'members.leaveLast':
    'You are the last member. Leaving deletes the group and everything in it — expenses, payments and receipts — from this device and from the server. This cannot be undone.',
  'members.leaveOthers':
    'The group is removed from this device. Everyone else keeps it, along with the entries you have already recorded — your name stays on them.',
  'members.leaveOrphans':
    'You are the last member who can read part of this group’s history. If you leave, those entries are lost to everyone, for good, and nothing can bring them back. Give someone else access to the earlier entries first if that matters.',
  'members.deleteForGood': 'Delete the group for good',
  'members.confirmLeave': 'Yes, leave the group',
  'members.leave': 'Leave group',
  // What happened to the keys after a decision. Said separately from the
  // decision itself, because by then the person is already a member.
  'members.scopedAdded':
    'Added from today onwards. Nothing recorded before now is readable to them, and they cannot pass this group’s history on.',
  'members.scopedNoKey': 'Added, but no new key could be minted — they may be able to read entries from before they joined.',
  'members.scopedRotateFailed':
    'Added, but the key rotation failed ({reason}). They cannot read anything yet; retry by removing and re-inviting them.',
  'members.addedPartial':
    'Added — but you joined this group partway through, so they can see only the same part of its history that you can.',
  'members.shareFailed': 'Added, but sharing the group with them failed ({reason}) — they cannot see anything yet.',
  'members.removedRotated': 'Removed, and the group key was rotated — they cannot read anything written from now on.',
  'members.removedRotateFailed':
    'Removed, but rotating the key failed ({reason}). They can still read new entries until an admin removes someone again or retries.',

  // --- following an invite link --------------------------------------------
  'invitePage.invitedBy': '{name} invited you to join',
  'invitePage.wasMember':
    'You were in this group before as {name}. Rejoining puts you back under that name with everything already recorded against it — there is nothing to pick below.',
  'invitePage.fromToday':
    'This invite shares the group from today onwards. Whatever has been recorded so far stays sealed — you will not see those amounts, and balances between other people will be incomplete for you. Your own balance will still be exact, because you were in none of those splits.',
  'invitePage.requestSent': 'Request sent. An admin of this group has to approve it before you can see anything.',
  'invitePage.sasIntro': 'If they ask you to confirm a code, it is',
  'invitePage.sasHint': 'Read it out to them — over a call, not over the same chat the link came from.',
  'invitePage.willOpen':
    'This page opens the group by itself the moment they approve. You will get a notification too, so it is safe to close.',
  'invitePage.backToGroups': 'Back to your groups',
  'invitePage.takeOverInstead': 'Taking over somebody else’s name instead?',
  'invitePage.areYouOne': 'Are you one of these people?',
  'invitePage.rejoinAs': 'No — rejoin as {name}',
  'invitePage.joinAsNew': 'No — join as someone new',
  'invitePage.claimAlso': '{name} (also {names})',
  'invitePage.claimLeft': '{name} — left this group',
  'invitePage.nameClash':
    'Somebody here is already called {name}. If that was meant to be you, pick the name above — otherwise join as someone new and you will be listed separately.',
  'invitePage.claimNote':
    'Picking a name takes over the expenses already recorded against it. Names marked “left this group” belonged to a real account — take one over only if it was yours and you cannot get back into it. Joining as someone new is always available, even while other names are still unclaimed.',
  'invitePage.joinAsThisPerson': 'Join as this person',
  'invitePage.rejoin': 'Rejoin group',
  'invitePage.join': 'Join group',
  'invitePage.logInToJoin': 'Log in or register to join',

  // --- scanning somebody in ------------------------------------------------
  'scan.start': 'Scan someone’s code',
  'scan.explain':
    'They open “{screen}” on their phone and show you the code. Adding them this way needs no link and no approval — you have already checked who they are.',
  'scan.notAJoinCode': 'That code is not a SpendApp join code.',
  'scan.alreadyMember': '{name} is already in this group.',
  'scan.addPrompt': 'Add {name} to this group?',
  'scan.returning': 'They have been here before — add them as:',
  'scan.pickExisting': 'Are they one of the people already listed?',
  'scan.asBefore': '{name}, as before — with their old entries',
  'scan.someoneNew': 'Someone new',
  'scan.labelAlso': '{name} (also {names})',
  'scan.labelLeft': '{name} — left this group',
  'scan.ownEntriesNote':
    'There is no way to bring this account back as a stranger to its own entries: those entries are addressed by the account itself, so returning always reunites them. Only a different account can start clean here.',
  'scan.add': 'Add {name}',
  'scan.admitted': '{name} is in, and can read the group’s history.',
  'scan.admittedKeyMismatch':
    '{name} is in, but the key on the server does not match the one you scanned. They can read the group because you wrapped it to the scanned key — but ask them to check their account.',

  // --- camera scanner ------------------------------------------------------
  'scan.noCamera': 'This browser cannot open a camera. Send them an invite link instead.',
  'scan.refused': 'Camera access was refused. Allow it, or send them an invite link instead.',
  'scan.failed': 'Could not open the camera: {reason}',
  'scan.decoderFailed': 'The scanner could not load. Check your connection and try again.',
  'scan.cancel': 'Cancel',

  // --- push -------------------------------------------------------------
  // Written here rather than on the server, which has no idea who is reading.
  // Deliberately say nothing about the entry itself (design §3.3).
  'push.expense.saved': '{actor} added or changed an expense',
  'push.expense.deleted': '{actor} deleted an expense',
  'push.payment.recorded': '{actor} recorded a payment',
  'push.comment.added': '{actor} commented on an expense',
  'push.member.joined': '{actor} joined the group',
  'push.member.left': '{actor} left the group',
  'push.member.removed': '{actor} removed a member',
  'push.join.requested': '{actor} asked to join',
  'push.join.approved': 'Your request to join was approved',
  'push.you.removed': 'You were removed from {group}',
  'push.you.promoted': 'You are now an admin',
  'push.you.promoted.lastAdminLeft': 'You are now an admin — the last one left the group',

  // --- errors from the API ------------------------------------------------
  'error.unexpected': 'Something went wrong. Try again.',
  'error.authentication_required': 'You are signed out. Log in and try again.',
  'error.not_found': 'That is not there any more.',
  'error.invalid_input': 'That does not look right — check the form and try again.',
  'error.client_update_required': 'This app is out of date. Reload the page to update it.',
  'error.username_taken': 'That username is taken.',
  // Says the rule rather than "check the form": it is the one thing here a
  // person can fix without guessing. Kept in step with `usernameSchema` by a
  // test — if the characters it accepts change, this has to say so.
  'error.invalid_username':
    'Username: 3–32 characters, starting and ending with a letter or digit. Allowed special characters: . _ - @',
  'error.invalid_credentials': 'Wrong username or password.',
  'error.too_many_attempts': 'Too many attempts on this account. Wait a few minutes and try again.',
  'error.wrong_password': 'Wrong password.',
  'error.no_such_account': 'No account with that name.',
  'error.policy_changed': 'The privacy policy changed while you were reading it. Reload and read it again.',
  'error.not_a_member': 'You are not in that group.',
  'error.last_admin': 'A group needs at least one admin.',
  'error.use_leave_to_remove_yourself': 'Use “leave” to remove yourself.',
  'error.no_pending_request': 'That request is no longer waiting.',
  'error.name_not_taken_over': 'That name was not taken over by anyone.',
  'error.already_you': 'That is already you.',
  'error.not_claimable': 'That name cannot be taken over.',
  'error.already_claimed': 'Somebody has already taken that name over.',
  'error.still_in_group': 'That person is still in this group.',
  'error.no_wraps_for_members': 'Nobody could be given access — try again.',
  'error.invite_invalid': 'This invite link is not valid any more.',
  'error.invite_spent': 'This invite link has already been used.',
  'error.join_declined': 'Your request to join was declined.',
  'error.attachment_missing': 'That receipt has not finished uploading.',
} satisfies Record<string, Message>;
