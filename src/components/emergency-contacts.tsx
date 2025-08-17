
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { User, Phone, Mail, Pencil } from "lucide-react";

const nameValidation = z.string().min(1, { message: "Name is required" }).regex(/^[a-zA-Z\s'-]+$/, { message: "Name can only contain letters, spaces, hyphens, and apostrophes." });
const phoneValidation = z.string().min(1, { message: "Phone number is required" }).regex(/^\+?[1-9]\d{1,14}$/, { message: "Invalid phone number format." });

const emergencyContactsSchema = z.object({
  contact1_name: nameValidation,
  contact1_email: z.string().email({ message: "Invalid email address." }),
  contact1_phone: phoneValidation,
  contact2_name: nameValidation.optional().or(z.literal('')),
  contact2_email: z.string().email({ message: "Invalid email address." }).optional().or(z.literal('')),
  contact2_phone: phoneValidation.optional().or(z.literal('')),
});

type EmergencyContactsFormValues = z.infer<typeof emergencyContactsSchema>;

const initialContacts: EmergencyContactsFormValues = {
    contact1_name: "Jane Doe",
    contact1_email: "jane.doe@example.com",
    contact1_phone: "+1234567890",
    contact2_name: "John Smith",
    contact2_email: "john.smith@example.com",
    contact2_phone: "+10987654321",
};

export function EmergencyContacts() {
  const [contacts, setContacts] = useState(initialContacts);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { toast } = useToast();

  const form = useForm<EmergencyContactsFormValues>({
    resolver: zodResolver(emergencyContactsSchema),
    defaultValues: contacts,
  });

  const onSubmit = (data: EmergencyContactsFormValues) => {
    setContacts(data);
    toast({
      title: "Success",
      description: "Emergency contacts updated successfully.",
    });
    setIsDialogOpen(false);
  };

  return (
    <Card className="shadow-lg">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-2xl font-headline">Emergency Contacts</CardTitle>
          <CardDescription>Your designated points of contact.</CardDescription>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="icon">
              <Pencil className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Edit Emergency Contacts</DialogTitle>
              <DialogDescription>
                Update the details of your emergency contacts here. Click save when you're done.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                 <div className="space-y-4 border p-4 rounded-lg">
                    <FormLabel className="font-bold">Emergency Contact 1</FormLabel>
                    <FormField control={form.control} name="contact1_name" render={({ field }) => (
                      <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Name" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                     <FormField control={form.control} name="contact1_email" render={({ field }) => (
                      <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" placeholder="Email" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                     <FormField control={form.control} name="contact1_phone" render={({ field }) => (
                      <FormItem><FormLabel>Phone</FormLabel><FormControl><Input type="tel" placeholder="Phone Number" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                  <div className="space-y-4 border p-4 rounded-lg">
                    <FormLabel className="font-bold">Emergency Contact 2 (Optional)</FormLabel>
                    <FormField control={form.control} name="contact2_name" render={({ field }) => (
                      <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Name" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                     <FormField control={form.control} name="contact2_email" render={({ field }) => (
                      <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" placeholder="Email" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                     <FormField control={form.control} name="contact2_phone" render={({ field }) => (
                      <FormItem><FormLabel>Phone</FormLabel><FormControl><Input type="tel" placeholder="Phone Number" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                 <DialogFooter>
                    <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
                    <Button type="submit">Save changes</Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
            <h4 className="font-semibold">Contact 1</h4>
            <div className="flex items-center gap-3 text-muted-foreground">
                <User className="h-5 w-5"/>
                <span>{contacts.contact1_name}</span>
            </div>
             <div className="flex items-center gap-3 text-muted-foreground">
                <Mail className="h-5 w-5"/>
                <span>{contacts.contact1_email}</span>
            </div>
             <div className="flex items-center gap-3 text-muted-foreground">
                <Phone className="h-5 w-5"/>
                <span>{contacts.contact1_phone}</span>
            </div>
        </div>
        {contacts.contact2_name && (
            <div className="space-y-4 border-t pt-4">
                <h4 className="font-semibold">Contact 2</h4>
                <div className="flex items-center gap-3 text-muted-foreground">
                    <User className="h-5 w-5"/>
                    <span>{contacts.contact2_name}</span>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                    <Mail className="h-5 w-5"/>
                    <span>{contacts.contact2_email}</span>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                    <Phone className="h-5 w-5"/>
                    <span>{contacts.contact2_phone}</span>
                </div>
            </div>
        )}
      </CardContent>
    </Card>
  );
}

