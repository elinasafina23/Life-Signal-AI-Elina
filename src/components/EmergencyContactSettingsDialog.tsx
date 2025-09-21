// src/components/EmergencyContactSettingsDialog.tsx
"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { db, auth } from "@/firebase";
import {
  doc,
  getDoc,
  setDoc,
  collectionGroup,
  query,
  where,
  getDocs,
  writeBatch,
  collection,
  serverTimestamp,
} from "firebase/firestore";
import {
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword,
} from "firebase/auth";

import { Pencil, Check, X } from "lucide-react";

interface Props {
  contactUid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EmergencyContactSettingsDialog({
  contactUid,
  open,
  onOpenChange,
}: Props) {
  const { toast } = useToast();

  // Profile state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const [editField, setEditField] = useState<string | null>(null);

  // Notifications
  const [defaultChannel, setDefaultChannel] = useState<"push" | "email" | "sms">(
    "push"
  );
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("07:00");
  const [highPriorityOverride, setHighPriorityOverride] = useState(true);

  // Escalation
  const [escalationEnabled, setEscalationEnabled] = useState(false);
  const [escalationMinutes, setEscalationMinutes] = useState<number | "">("");
  const [escalationContactUids, setEscalationContactUids] = useState<string[]>([]);

  // Repeats
  const [repeatEveryMinutes, setRepeatEveryMinutes] = useState<number | "">("");
  const [maxRepeatsPerWindow, setMaxRepeatsPerWindow] = useState<number | "">("");

  // App prefs
  const [darkModeEnabled, setDarkModeEnabled] = useState(false);
  const [language, setLanguage] = useState("en");
  const [timeZone, setTimeZone] = useState("");

  // Password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);

  // Load profile
  useEffect(() => {
    if (!open || !contactUid) return;

    (async () => {
      try {
        const userRef = doc(db, "users", contactUid);
        const snap = await getDoc(userRef);
        if (snap.exists()) {
          const d = snap.data() as any;
          setFirstName(d.firstName ?? "");
          setLastName(d.lastName ?? "");
          setEmail(d.email ?? "");
          setPhone(d.phone ?? "");
          setDefaultChannel(d.defaultChannel ?? "push");

          if (d.quietStart && d.quietEnd) {
            setQuietHoursEnabled(true);
            setQuietStart(d.quietStart);
            setQuietEnd(d.quietEnd);
          } else {
            setQuietHoursEnabled(false);
          }

          setHighPriorityOverride(d.highPriorityOverride ?? true);
          setEscalationEnabled(d.escalationEnabled ?? false);
          setEscalationMinutes(d.escalationMinutes ?? "");
          setEscalationContactUids(d.escalationContactUids ?? []);
          setRepeatEveryMinutes(d.repeatEveryMinutes ?? "");
          setMaxRepeatsPerWindow(d.maxRepeatsPerWindow ?? "");
          setDarkModeEnabled(d.darkModeEnabled ?? false);
          setLanguage(d.language ?? "en");
          setTimeZone(d.timeZone ?? "");
        }
      } catch (err) {
        console.error("Load failed", err);
        toast({
          title: "Load failed",
          description: "Could not load your profile.",
          variant: "destructive",
        });
      }
    })();
  }, [open, contactUid, toast]);

  // Find linked main users
  async function findLinkedMainUsers() {
    const q = query(
      collectionGroup(db, "emergency_contact"),
      where("uid", "==", contactUid)
    );
    const snap = await getDocs(q);
    const res: { mainUserUid: string; docRefPath: string }[] = [];
    snap.forEach((d) => {
      const mainUserId = d.ref.parent.parent?.id;
      if (mainUserId) {
        res.push({ mainUserUid: mainUserId, docRefPath: d.ref.path });
      }
    });
    return res;
  }

  // Validation helper
  const validateInputs = () => {
    if (!firstName.trim() || !lastName.trim()) {
      toast({
        title: "Missing name",
        description: "First and last name are required.",
        variant: "destructive",
      });
      return false;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address.",
        variant: "destructive",
      });
      return false;
    }
    if (phone && !/^\d+$/.test(phone)) {
      toast({
        title: "Invalid phone",
        description: "Phone number should contain digits only.",
        variant: "destructive",
      });
      return false;
    }
    return true;
  };

  // Save handler
  const handleSave = async () => {
    if (!contactUid) return;
    if (!validateInputs()) return;

    setSaving(true);

    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();

      const data: any = {
        role: "emergency_contact",
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        name: fullName,
        displayName: fullName,
        email: email.trim(),
        phone: phone.trim(),
        defaultChannel,
        highPriorityOverride,
        escalationEnabled,
        escalationMinutes: escalationMinutes || null,
        escalationContactUids,
        repeatEveryMinutes: repeatEveryMinutes || 0,
        maxRepeatsPerWindow: maxRepeatsPerWindow || null,
        darkModeEnabled,
        language,
        timeZone,
        updatedAt: serverTimestamp(),
      };

      if (quietHoursEnabled) {
        data.quietStart = quietStart;
        data.quietEnd = quietEnd;
      } else {
        data.quietStart = null;
        data.quietEnd = null;
      }

      // Update own profile
      const contactRef = doc(db, "users", contactUid);
      await setDoc(contactRef, data, { merge: true });

      // Update linked main users (dashboard view)
      const linked = await findLinkedMainUsers();
      if (linked.length > 0) {
        const batch = writeBatch(db);
        for (const l of linked) {
          const ecRef = doc(db, l.docRefPath);
          batch.set(
            ecRef,
            { name: fullName, email, phone, updatedAt: serverTimestamp() },
            { merge: true }
          );
          const notifRef = collection(db, "users", l.mainUserUid, "notifications");
          batch.set(doc(notifRef), {
            type: "contact_updated",
            title: "Emergency contact updated",
            body: `${fullName} updated their info.`,
            data: { contactUid, contactName: fullName },
            createdAt: serverTimestamp(),
            read: false,
          });
        }
        await batch.commit();
      }

      toast({ title: "Saved", description: "Settings updated and synced." });
      onOpenChange(false);
    } catch (err: any) {
      console.error("Save failed", err);
      toast({
        title: "Save failed",
        description: err?.message || "Could not save.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  // Editable field helper
  const renderEditableField = (
    label: string,
    value: string,
    isEditing: boolean,
    onChange: (val: string) => void,
    fieldKey: string
  ) => (
    <div className="flex flex-col space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        {isEditing ? (
          <>
            <Input value={value} onChange={(e) => onChange(e.target.value)} />
            <Button size="icon" variant="ghost" onClick={() => setEditField(null)}>
              <Check className="w-4 h-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setEditField(null)}>
              <X className="w-4 h-4" />
            </Button>
          </>
        ) : (
          <>
            <span className="flex-1 text-sm">{value || "—"}</span>
            <Button size="icon" variant="ghost" onClick={() => setEditField(fieldKey)}>
              <Pencil className="w-4 h-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>My Settings</DialogTitle>
          <DialogDescription>
            Edit your profile, notifications, and app settings.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          {/* Profile */}
          <div className="space-y-3">
            {renderEditableField(
              "First Name",
              firstName,
              editField === "firstName",
              setFirstName,
              "firstName"
            )}
            {renderEditableField(
              "Last Name",
              lastName,
              editField === "lastName",
              setLastName,
              "lastName"
            )}
            {renderEditableField(
              "Email",
              email,
              editField === "email",
              setEmail,
              "email"
            )}
            {renderEditableField(
              "Phone",
              phone,
              editField === "phone",
              setPhone,
              "phone"
            )}
          </div>

          {/* Notifications & Prefs */}
          <div className="space-y-3">
            <Label>Default Notification Channel</Label>
            <Select
              value={defaultChannel}
              onValueChange={(v) => setDefaultChannel(v as any)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select channel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="push">Push</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="sms">SMS</SelectItem>
              </SelectContent>
            </Select>

            <div>
              <Label>Quiet Hours</Label>
              <div className="flex items-center gap-2 mt-1">
                <Switch
                  checked={quietHoursEnabled}
                  onCheckedChange={(v) => setQuietHoursEnabled(Boolean(v))}
                />
                <span className="text-sm text-muted-foreground">
                  Enable quiet hours
                </span>
              </div>
              {quietHoursEnabled && (
                <div className="flex gap-2 mt-2">
                  <Input
                    type="time"
                    value={quietStart}
                    onChange={(e) => setQuietStart(e.target.value)}
                  />
                  <Input
                    type="time"
                    value={quietEnd}
                    onChange={(e) => setQuietEnd(e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-between">
              <Label>Always notify for SOS</Label>
              <Switch
                checked={highPriorityOverride}
                onCheckedChange={(v) => setHighPriorityOverride(Boolean(v))}
              />
            </div>

            <div>
              <Label>Escalation</Label>
              <div className="flex items-center gap-2 mt-1">
                <Switch
                  checked={escalationEnabled}
                  onCheckedChange={(v) => setEscalationEnabled(Boolean(v))}
                />
                <span className="text-sm text-muted-foreground">
                  Enable automatic escalation
                </span>
              </div>
              {escalationEnabled && (
                <>
                  <Label className="mt-2">Escalation delay (minutes)</Label>
                  <Input
                    type="number"
                    value={String(escalationMinutes)}
                    onChange={(e) =>
                      setEscalationMinutes(Number(e.target.value) || "")
                    }
                  />
                </>
              )}
            </div>

            <div>
              <Label>Repeat notifications</Label>
              <div className="flex gap-2 items-center">
                <Input
                  type="number"
                  placeholder="Every (min)"
                  value={String(repeatEveryMinutes)}
                  onChange={(e) =>
                    setRepeatEveryMinutes(Number(e.target.value) || "")
                  }
                />
                <Input
                  type="number"
                  placeholder="Max repeats"
                  value={String(maxRepeatsPerWindow)}
                  onChange={(e) =>
                    setMaxRepeatsPerWindow(Number(e.target.value) || "")
                  }
                />
              </div>
            </div>

            <div>
              <Label>App preferences</Label>
              <div className="flex items-center justify-between">
                <span>Dark mode</span>
                <Switch
                  checked={darkModeEnabled}
                  onCheckedChange={(v) => setDarkModeEnabled(Boolean(v))}
                />
              </div>

              <Label className="mt-2">Language</Label>
              <Select value={language} onValueChange={(v) => setLanguage(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="es">Spanish</SelectItem>
                  <SelectItem value="fr">French</SelectItem>
                </SelectContent>
              </Select>

              <Label className="mt-2">Timezone</Label>
              <Input
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                placeholder="e.g. America/New_York"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save & notify"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default EmergencyContactSettingsDialog;
