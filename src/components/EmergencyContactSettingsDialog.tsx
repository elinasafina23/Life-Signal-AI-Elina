// src/components/EmergencyContactSettingsDialog.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
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
import { db } from "@/firebase";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  collectionGroup,
  query,
  where,
  getDocs,
} from "firebase/firestore";
import { Pencil, Check, X } from "lucide-react";

// -------------------- Props --------------------
interface Props {
  /** Canonical prop name for the signed-in emergency contact UID */
  emergencyContactUid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Optional: configure where the policy update POST should go */
const UPDATE_POLICY_URL = "/api/emergency_contact/update_policy";

type PolicyMode = "push_then_call" | "call_immediately";

/* -------------------- Helpers: email & phone validation -------------------- */
const isEmail = (v?: string) =>
  !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/** Telnyx-friendly E.164: +, country code 1–3 digits, then national digits (total 8–15). */
const isE164 = (v?: string) =>
  !!v && /^\+[1-9]\d{7,14}$/.test(v.trim());

/** Keep only one leading + and digits; drop spaces, dashes, parens, etc. */
function sanitizePhoneInput(raw: string) {
  const trimmed = raw.trim();
  let s = trimmed.replace(/[^\d+]/g, "");
  s = s[0] === "+" ? ("+" + s.slice(1).replace(/\+/g, "")) : s.replace(/\+/g, "");
  return s;
}

export function EmergencyContactSettingsDialog({
  emergencyContactUid,
  open,
  onOpenChange,
}: Props) {
  const { toast } = useToast();

  // -------------------- Local state --------------------
  // Profile
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [editField, setEditField] = useState<string | null>(null);

  // Notifications
  const [defaultChannel, setDefaultChannel] =
    useState<"push" | "email" | "sms">("push");
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("07:00");
  const [highPriorityOverride, setHighPriorityOverride] = useState(true);

  // Escalation (legacy EC prefs you already had – kept as-is)
  const [escalationEnabled, setEscalationEnabled] = useState(false);
  const [escalationMinutes, setEscalationMinutes] = useState<number | "">("");
  const [escalationContactUids, setEscalationContactUids] = useState<string[]>(
    []
  );

  // Repeats
  const [repeatEveryMinutes, setRepeatEveryMinutes] = useState<number | "">("");
  const [maxRepeatsPerWindow, setMaxRepeatsPerWindow] = useState<number | "">(
    ""
  );

  // App prefs
  const [darkModeEnabled, setDarkModeEnabled] = useState(false);
  const [language, setLanguage] = useState("en");
  const [timeZone, setTimeZone] = useState("");

  const [saving, setSaving] = useState(false);

  // -------------------- NEW: main-user policy editor state --------------------
  const [linkedMainUsers, setLinkedMainUsers] = useState<
    Array<{ uid: string; name: string }>
  >([]);
  const [selectedMainUserUid, setSelectedMainUserUid] = useState("");
  const [policyMode, setPolicyMode] = useState<PolicyMode>("push_then_call");
  const [policyDelaySec, setPolicyDelaySec] = useState<number>(60);
  const [policySaving, setPolicySaving] = useState(false);

  // -------------------- Load profile --------------------
  useEffect(() => {
    if (!open || !emergencyContactUid) return;

    (async () => {
      try {
        const userRef = doc(db, "users", emergencyContactUid);
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
  }, [open, emergencyContactUid, toast]);

  // -------------------- NEW: load linked main users for this EC --------------------
  useEffect(() => {
    if (!open || !emergencyContactUid) return;

    (async () => {
      try {
        const q = query(
          collectionGroup(db, "emergency_contact"),
          where("emergencyContactUid", "==", emergencyContactUid)
        );
        const cg = await getDocs(q);

        const rows = await Promise.all(
          cg.docs.map(async (d) => {
            const data = d.data() as any;
            const uid: string =
              data.mainUserUid ||
              d.ref.parent.parent?.id ||
              ""; // fallback to parent id
            let name: string = data.mainUserName || "";

            if (!name && uid) {
              const mu = await getDoc(doc(db, "users", uid));
              const md = mu.data() as any;
              if (md) {
                name =
                  md.name ||
                  `${md.firstName || ""} ${md.lastName || ""}`.trim() ||
                  uid;
              } else {
                name = uid;
              }
            }
            return uid ? { uid, name } : null;
          })
        );

        const unique = Array.from(
          new Map(
            rows.filter(Boolean).map((r) => [r!.uid, r!])
          ).values()
        );

        setLinkedMainUsers(unique);
        if (!selectedMainUserUid && unique.length > 0) {
          setSelectedMainUserUid(unique[0].uid);
        }
      } catch (e) {
        console.error("Failed to load linked main users", e);
      }
    })();
  }, [open, emergencyContactUid]); // eslint-disable-line

  // -------------------- NEW: load existing policy for selected main user --------------------
  useEffect(() => {
    if (!open || !selectedMainUserUid) return;
    (async () => {
      try {
        const mu = await getDoc(doc(db, "users", selectedMainUserUid));
        if (mu.exists()) {
          const d = mu.data() as any;
          const p = d.escalationPolicy || {};
          setPolicyMode((p.mode as PolicyMode) || "push_then_call");
          setPolicyDelaySec(Number(p.callDelaySec || 60));
        }
      } catch (e) {
        console.error("Failed to load policy", e);
      }
    })();
  }, [open, selectedMainUserUid]);

  // -------------------- Validation --------------------
  const validateInputs = () => {
    if (!firstName.trim() || !lastName.trim()) {
      toast({
        title: "Missing name",
        description: "First and last name are required.",
        variant: "destructive",
      });
      return false;
    }
    if (email && !isEmail(email)) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address.",
        variant: "destructive",
      });
      return false;
    }
    // Require E.164 phone (Telnyx compatible)
    if (!phone.trim() || !isE164(phone)) {
      toast({
        title: "Invalid phone",
        description: "Phone must include country code, e.g. +15551234567",
        variant: "destructive",
      });
      return false;
    }
    return true;
  };

  // -------------------- Save EC profile --------------------
  const handleSave = async () => {
    if (!emergencyContactUid) return;
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
        phone: phone.trim(), // already sanitized & E.164-validated
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

      // 1) Update my own profile
      const contactRef = doc(db, "users", emergencyContactUid);
      await setDoc(contactRef, data, { merge: true });

      // 2) Fan-out to linked main users (server-side)
      try {
        const res = await fetch("/api/emergency_contact/sync_profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            emergencyContactUid,
            name: fullName,
            email: email.trim(),
            phone: phone.trim(), // E.164
          }),
        });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({}));
          throw new Error(error || "Sync failed");
        }
      } catch (e) {
        // Non-fatal
        console.error("Server sync failed:", e);
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

  // -------------------- Policy save --------------------
  const handleSavePolicy = async () => {
    if (!selectedMainUserUid) {
      toast({
        title: "Select a user",
        description: "Choose a main user to apply the policy to.",
        variant: "destructive",
      });
      return;
    }
    setPolicySaving(true);
    try {
      if (UPDATE_POLICY_URL) {
        const r = await fetch(UPDATE_POLICY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            mainUserUid: selectedMainUserUid,
            mode: policyMode,
            callDelaySec: policyDelaySec,
          }),
        });
        if (!r.ok) {
          const { error } = await r.json().catch(() => ({}));
          throw new Error(error || "Policy update failed");
        }
      } else {
        await setDoc(
          doc(db, "users", selectedMainUserUid),
          {
            escalationPolicy: {
              version: 1,
              mode: policyMode,
              callDelaySec: policyDelaySec,
              updatedAt: serverTimestamp(),
            },
          },
          { merge: true }
        );
      }

      toast({
        title: "Policy saved",
        description: "Escalation policy updated for the selected user.",
      });
    } catch (e: any) {
      console.error(e);
      toast({
        title: "Save failed",
        description: e?.message || "Could not save policy.",
        variant: "destructive",
      });
    } finally {
      setPolicySaving(false);
    }
  };

  // -------------------- UI helpers --------------------
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
            {fieldKey === "phone" ? (
              <div className="flex-1">
                <Input
                  type="tel"
                  inputMode="tel"
                  pattern="^\+[1-9]\d{7,14}$"
                  placeholder="+15551234567"
                  value={value}
                  onChange={(e) => onChange(sanitizePhoneInput(e.target.value))}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Must include country code (E.164), e.g. +15551234567
                </p>
              </div>
            ) : (
              <Input
                className="flex-1"
                value={value}
                onChange={(e) => onChange(e.target.value)}
              />
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setEditField(null)}
              aria-label="Save"
            >
              <Check className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setEditField(null)}
              aria-label="Cancel"
            >
              <X className="w-4 h-4" />
            </Button>
          </>
        ) : (
          <>
            <span className="flex-1 text-sm">{value || "—"}</span>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setEditField(fieldKey)}
              aria-label={`Edit ${label}`}
            >
              <Pencil className="w-4 h-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );

  const policyDelayVisible = policyMode === "push_then_call";

  // -------------------- Render --------------------
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>My Settings</DialogTitle>
          <DialogDescription>
            Edit your profile, notifications, and escalation preferences.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
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
              <Label className="mb-1 block">Escalation (EC prefs)</Label>
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

          {/* -------------------- Policy editor (per main user) -------------------- */}
          <div className="md:col-span-2 border rounded-lg p-4 space-y-3">
            <div className="flex flex-col md:flex-row md:items-end gap-3">
              <div className="flex-1">
                <Label>Manage policy for user</Label>
                <Select
                  value={selectedMainUserUid}
                  onValueChange={setSelectedMainUserUid}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a main user" />
                  </SelectTrigger>
                  <SelectContent>
                    {linkedMainUsers.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        No linked main users found.
                      </div>
                    ) : (
                      linkedMainUsers.map((u) => (
                        <SelectItem key={u.uid} value={u.uid}>
                          {u.name || u.uid}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex-1">
                <Label>Policy mode</Label>
                <Select
                  value={policyMode}
                  onValueChange={(v) => setPolicyMode(v as PolicyMode)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="push_then_call">
                      Push first, then call
                    </SelectItem>
                    <SelectItem value="call_immediately">
                      Call immediately
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {policyDelayVisible && (
                <div className="w-full md:w-48">
                  <Label>Call delay (sec)</Label>
                  <Input
                    type="number"
                    value={String(policyDelaySec)}
                    onChange={(e) =>
                      setPolicyDelaySec(Math.max(0, Number(e.target.value) || 0))
                    }
                  />
                </div>
              )}

              <div className="mt-2 md:mt-0">
                <Button onClick={handleSavePolicy} disabled={policySaving}>
                  {policySaving ? "Saving..." : "Save Policy"}
                </Button>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              This policy is saved on the selected main user’s profile and is
              used by the scheduler and call workflow. Your personal settings
              above stay intact.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
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
