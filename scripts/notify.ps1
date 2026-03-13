param(
  [string]$Title = "Codex",
  [string]$Message = "Terminado"
)

function Send-Toast {
  param(
    [string]$Title,
    [string]$Message
  )

  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  } catch {
    return $false
  }

  $template = @"
<toast duration="short">
  <visual>
    <binding template="ToastGeneric">
      <text>$Title</text>
      <text>$Message</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
"@

  try {
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($template)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Windows PowerShell")
    $notifier.Show($toast)
    return $true
  } catch {
    return $false
  }
}

# Best-effort toast notification with a guaranteed sound.
$sent = Send-Toast -Title $Title -Message $Message
try {
  [System.Media.SystemSounds]::Exclamation.Play()
} catch {
  [console]::beep(800, 300)
}

