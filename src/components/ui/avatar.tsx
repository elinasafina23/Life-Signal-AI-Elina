"use client"

// Imports React and the Radix UI Avatar primitives.
import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

// Imports a utility function for conditional class names.
import { cn } from "@/lib/utils"

// Defines the main Avatar component. It's a forwardRef component to allow refs to be passed to it.
const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  // Renders the Radix UI Avatar.Root primitive.
  <AvatarPrimitive.Root
    ref={ref}
    // Applies a set of default styles and any additional class names.
    className={cn(
      "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
      className
    )}
    {...props}
  />
))
// Assigns a display name for better debugging in React DevTools.
Avatar.displayName = AvatarPrimitive.Root.displayName

// Defines the AvatarImage component, also a forwardRef component.
const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  // Renders the Radix UI Avatar.Image primitive.
  <AvatarPrimitive.Image
    ref={ref}
    // Applies default styles for the image and additional class names.
    className={cn("aspect-square h-full w-full", className)}
    {...props}
  />
))
// Assigns a display name for debugging.
AvatarImage.displayName = AvatarPrimitive.Image.displayName

// Defines the AvatarFallback component, which displays when the image fails to load.
const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  // Renders the Radix UI Avatar.Fallback primitive.
  <AvatarPrimitive.Fallback
    ref={ref}
    // Applies default styles to center content and set a background color.
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-muted",
      className
    )}
    {...props}
  />
))
// Assigns a display name for debugging.
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

// Exports the components for use throughout the application.
export { Avatar, AvatarImage, AvatarFallback }