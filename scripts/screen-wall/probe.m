// What a program an agent compiles itself can do to a Mac's screen without going through any
// system tool (INV-1756): post input, move the pointer, capture the display, read other apps
// through Accessibility. Each subcommand is one way in; `measure.sh` runs them bare and under the
// box's Seatbelt profile and compares.
//
// NEVER RUN THIS IN A PERSON'S SESSION. It moves the pointer and captures the screen, and the
// runs that are "supposed to be refused" land on the desktop when the refusal is wrong. It is for
// a disposable session only: a CI runner, a throwaway user account. `measure.sh` refuses to start
// anywhere else.
//
//   clang -fobjc-arc -framework ApplicationServices -framework IOKit -framework ImageIO \
//         -framework CoreServices -framework Foundation -o probe probe.m
//
// The capture calls are found by name at run time: newer SDKs no longer declare them, the system
// still has them, and a program that wants the screen does not care what the headers say.

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/hidsystem/IOHIDLib.h>
#import <IOKit/hidsystem/IOHIDShared.h>
#import <ImageIO/ImageIO.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static int usage(void) {
  fprintf(stderr, "usage: probe state|where|move X Y|warp X Y|hidpost X Y|hiddevice|capture OUT|wincapture OUT|sck OUT|render OUT|windows|ax PID\n");
  return 64;
}

static void *symbol(const char *name) {
  return dlsym(RTLD_DEFAULT, name);
}

// A capture is believed only when it has pixels that differ: a refused capture is sometimes a
// null image and sometimes a flat one.
static int writeImage(CGImageRef image, const char *path) {
  if (image == NULL) {
    printf("capture: null image\n");
    return 1;
  }
  size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
  CFDataRef data = CGDataProviderCopyData(CGImageGetDataProvider(image));
  size_t distinct = 0;
  if (data != NULL) {
    const UInt8 *bytes = CFDataGetBytePtr(data);
    CFIndex length = CFDataGetLength(data);
    for (CFIndex i = 4; i + 3 < length; i += 4099 * 4)
      if (memcmp(bytes, bytes + i, 3) != 0) distinct++;
    CFRelease(data);
  }
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, (CFIndex)strlen(path), false);
  CGImageDestinationRef destination = CGImageDestinationCreateWithURL(url, CFSTR("public.png"), 1, NULL);
  bool written = false;
  if (destination != NULL) {
    CGImageDestinationAddImage(destination, image, NULL);
    written = CGImageDestinationFinalize(destination);
    CFRelease(destination);
  }
  CFRelease(url);
  printf("capture: %zux%zu, %zu sampled pixels differ from the first, file %s\n", width, height, distinct, written ? "written" : "NOT written");
  return width > 0 && height > 0 ? 0 : 1;
}

static int state(void) {
  bool (*capturePreflight)(void) = symbol("CGPreflightScreenCaptureAccess");
  bool (*postPreflight)(void) = symbol("CGPreflightPostEventAccess");
  bool (*listenPreflight)(void) = symbol("CGPreflightListenEventAccess");
  printf("screen-recording: %s\n", capturePreflight == NULL ? "unknown" : capturePreflight() ? "granted" : "not granted");
  printf("post-events: %s\n", postPreflight == NULL ? "unknown" : postPreflight() ? "granted" : "not granted");
  printf("listen-events: %s\n", listenPreflight == NULL ? "unknown" : listenPreflight() ? "granted" : "not granted");
  printf("accessibility: %s\n", AXIsProcessTrusted() ? "granted" : "not granted");
  CFDictionaryRef session = CGSessionCopyCurrentDictionary();
  printf("window-server-session: %s\n", session == NULL ? "none" : "present");
  if (session != NULL) {
    CFBooleanRef console = CFDictionaryGetValue(session, CFSTR("kCGSSessionOnConsoleKey"));
    printf("on-console: %s\n", console == NULL ? "unknown" : CFBooleanGetValue(console) ? "yes" : "no");
    CFRelease(session);
  }
  CGDirectDisplayID display = CGMainDisplayID();
  printf("main-display: %u %zux%zu\n", display, CGDisplayPixelsWide(display), CGDisplayPixelsHigh(display));
  return 0;
}

static int where(void) {
  CGEventRef event = CGEventCreate(NULL);
  if (event == NULL) {
    printf("pointer: unknown\n");
    return 1;
  }
  CGPoint at = CGEventGetLocation(event);
  CFRelease(event);
  printf("pointer: %.0f %.0f\n", at.x, at.y);
  return 0;
}

static int move(CGPoint to) {
  CGEventRef event = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, to, kCGMouseButtonLeft);
  if (event == NULL) {
    printf("move: no event\n");
    return 1;
  }
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  usleep(300000);
  printf("move: posted\n");
  return 0;
}

static int warp(CGPoint to) {
  CGError error = CGWarpMouseCursorPosition(to);
  usleep(300000);
  printf("warp: CGError %d\n", error);
  return error == kCGErrorSuccess ? 0 : 1;
}

// The older way in: the HID system's own user client, an IOKit open rather than a Mach lookup.
static int hidpost(CGPoint to) {
  io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching(kIOHIDSystemClass));
  if (service == IO_OBJECT_NULL) {
    printf("hidpost: no HID system service\n");
    return 1;
  }
  io_connect_t connection = IO_OBJECT_NULL;
  kern_return_t opened = IOServiceOpen(service, mach_task_self(), kIOHIDParamConnectType, &connection);
  IOObjectRelease(service);
  if (opened != KERN_SUCCESS) {
    printf("hidpost: open refused 0x%x\n", opened);
    return 1;
  }
  NXEventData data;
  memset(&data, 0, sizeof data);
  IOGPoint location = {(SInt16)to.x, (SInt16)to.y};
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  kern_return_t posted = IOHIDPostEvent(connection, NX_MOUSEMOVED, location, &data, kNXEventDataVersion, 0, kIOHIDSetCursorPosition);
#pragma clang diagnostic pop
  IOServiceClose(connection);
  usleep(300000);
  printf("hidpost: 0x%x\n", posted);
  return posted == KERN_SUCCESS ? 0 : 1;
}

static int capture(const char *path) {
  CGImageRef (*create)(CGDirectDisplayID) = symbol("CGDisplayCreateImage");
  if (create == NULL) {
    printf("capture: CGDisplayCreateImage is not in this system\n");
    return 2;
  }
  CGImageRef image = create(CGMainDisplayID());
  int result = writeImage(image, path);
  if (image != NULL) CGImageRelease(image);
  return result;
}

static int wincapture(const char *path) {
  CGImageRef (*create)(CGRect, uint32_t, uint32_t, uint32_t) = symbol("CGWindowListCreateImage");
  if (create == NULL) {
    printf("capture: CGWindowListCreateImage is not in this system\n");
    return 2;
  }
  CGImageRef image = create(CGRectInfinite, kCGWindowListOptionOnScreenOnly, kCGNullWindowID, 0);
  int result = writeImage(image, path);
  if (image != NULL) CGImageRelease(image);
  return result;
}

// ScreenCaptureKit, reached by name so this builds with any SDK: the shareable content, then one
// screenshot of the first display.
static int sck(const char *path) {
  if (dlopen("/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit", RTLD_NOW) == NULL) {
    printf("sck: no ScreenCaptureKit\n");
    return 2;
  }
  Class contentClass = NSClassFromString(@"SCShareableContent");
  Class filterClass = NSClassFromString(@"SCContentFilter");
  Class configurationClass = NSClassFromString(@"SCStreamConfiguration");
  Class managerClass = NSClassFromString(@"SCScreenshotManager");
  if (contentClass == Nil || filterClass == Nil || configurationClass == Nil) {
    printf("sck: classes missing\n");
    return 2;
  }
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block int result = 1;
  void (^gotContent)(id, NSError *) = ^(id content, NSError *error) {
    if (content == nil) {
      printf("sck: shareable content refused: %s\n", error.description.UTF8String);
      dispatch_semaphore_signal(done);
      return;
    }
    NSArray *displays = [content valueForKey:@"displays"];
    NSArray *windows = [content valueForKey:@"windows"];
    printf("sck: shareable content lists %lu displays, %lu windows\n", (unsigned long)displays.count, (unsigned long)windows.count);
    if (displays.count == 0 || managerClass == Nil) {
      printf("sck: no screenshot taken (%s)\n", displays.count == 0 ? "no display" : "no screenshot manager on this system");
      dispatch_semaphore_signal(done);
      return;
    }
    id filter = ((id (*)(id, SEL, id, id))objc_msgSend)([filterClass alloc], NSSelectorFromString(@"initWithDisplay:excludingWindows:"), displays[0], @[]);
    id configuration = [[configurationClass alloc] init];
    void (^gotImage)(CGImageRef, NSError *) = ^(CGImageRef image, NSError *imageError) {
      if (image == NULL) printf("sck: screenshot refused: %s\n", imageError.description.UTF8String);
      else result = writeImage(image, path);
      dispatch_semaphore_signal(done);
    };
    ((void (*)(id, SEL, id, id, id))objc_msgSend)(managerClass, NSSelectorFromString(@"captureImageWithFilter:configuration:completionHandler:"), filter, configuration, gotImage);
  };
  ((void (*)(id, SEL, id))objc_msgSend)(contentClass, NSSelectorFromString(@"getShareableContentWithCompletionHandler:"), gotContent);
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0) {
    printf("sck: no answer in 15s\n");
    return 1;
  }
  return result;
}

// What is on the screen without a picture of it: the window list, with titles where Screen
// Recording is granted.
static int windows(void) {
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (list == NULL) {
    printf("windows: no list\n");
    return 1;
  }
  CFIndex count = CFArrayGetCount(list), named = 0;
  for (CFIndex i = 0; i < count; i++)
    if (CFDictionaryContainsKey(CFArrayGetValueAtIndex(list, i), kCGWindowName)) named++;
  CFRelease(list);
  printf("windows: %ld on screen, %ld with a title\n", (long)count, (long)named);
  return count > 0 ? 0 : 1;
}

// Accessibility reads and drives another app without posting an event (a button is pressed by
// name). Reading one attribute of a running app is enough to show the door is open.
static int ax(pid_t pid) {
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  CFTypeRef role = NULL;
  AXError error = AXUIElementCopyAttributeValue(application, kAXRoleAttribute, &role);
  CFArrayRef names = NULL;
  AXError listed = AXUIElementCopyAttributeNames(application, &names);
  printf("ax: role AXError %d, %ld attribute names (AXError %d)\n", error, names == NULL ? 0L : (long)CFArrayGetCount(names), listed);
  if (role != NULL) CFRelease(role);
  if (names != NULL) CFRelease(names);
  CFRelease(application);
  return error == kAXErrorSuccess ? 0 : 1;
}

// A pointing device of our own making: a virtual HID mouse that reports movement. macOS asks for
// an entitlement an unsigned program cannot carry, so this is expected to be refused bare — and
// is here so that the day it is not, the measurement says so.
static int hiddevice(void) {
  static const uint8_t descriptor[] = {0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x09, 0x01, 0xa1, 0x00, 0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81,
                                       0x02, 0x95, 0x01, 0x75, 0x05, 0x81, 0x03, 0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x02, 0x81, 0x06, 0xc0, 0xc0};
  CFTypeRef (*create)(CFAllocatorRef, CFDictionaryRef, uint32_t) = symbol("IOHIDUserDeviceCreateWithProperties");
  kern_return_t (*report)(CFTypeRef, const uint8_t *, CFIndex) = symbol("IOHIDUserDeviceHandleReport");
  if (create == NULL || report == NULL) {
    printf("hiddevice: not in this system\n");
    return 2;
  }
  NSDictionary *properties = @{@"ReportDescriptor" : [NSData dataWithBytes:descriptor length:sizeof descriptor], @"VendorID" : @0x1234, @"ProductID" : @0x5678, @"Product" : @"probe pointer"};
  CFTypeRef device = create(NULL, (__bridge CFDictionaryRef)properties, 0);
  if (device == NULL) {
    printf("hiddevice: no device made\n");
    return 1;
  }
  sleep(2);
  kern_return_t sent = KERN_SUCCESS;
  for (int i = 0; i < 5; i++) {
    const uint8_t moved[] = {0, 60, 40};
    sent = report(device, moved, sizeof moved);
    usleep(50000);
  }
  usleep(300000);
  CFRelease(device);
  printf("hiddevice: device made, report 0x%x\n", sent);
  return sent == KERN_SUCCESS ? 0 : 1;
}

// The render server draws the display into a surface for whoever asks by name. Not a documented
// call; tried because it is a second service that holds the screen's pixels.
static int render(const char *path) {
  dlopen("/System/Library/Frameworks/QuartzCore.framework/QuartzCore", RTLD_NOW);
  dlopen("/System/Library/Frameworks/IOSurface.framework/IOSurface", RTLD_NOW);
  void (*renderDisplay)(mach_port_t, CFStringRef, CFTypeRef, int, int) = symbol("CARenderServerRenderDisplay");
  CFTypeRef (*surfaceCreate)(CFDictionaryRef) = symbol("IOSurfaceCreate");
  int (*lock)(CFTypeRef, uint32_t, uint32_t *) = symbol("IOSurfaceLock");
  void *(*base)(CFTypeRef) = symbol("IOSurfaceGetBaseAddress");
  size_t (*allocated)(CFTypeRef) = symbol("IOSurfaceGetAllocSize");
  if (renderDisplay == NULL || surfaceCreate == NULL || lock == NULL || base == NULL || allocated == NULL) {
    printf("render: not in this system\n");
    return 2;
  }
  NSDictionary *properties = @{@"IOSurfaceWidth" : @1024, @"IOSurfaceHeight" : @768, @"IOSurfaceBytesPerElement" : @4, @"IOSurfacePixelFormat" : @((unsigned)'BGRA')};
  size_t lit = 0;
  for (NSString *name in @[@"LCD", @"1", [NSString stringWithFormat:@"%u", CGMainDisplayID()]]) {
    CFTypeRef surface = surfaceCreate((__bridge CFDictionaryRef)properties);
    if (surface == NULL) continue;
    renderDisplay(0, (__bridge CFStringRef)name, surface, 0, 0);
    lock(surface, 1, NULL);
    const uint8_t *bytes = base(surface);
    size_t length = allocated(surface);
    for (size_t i = 0; bytes != NULL && i < length; i += 4099) lit += bytes[i] != 0;
    if (lit > 0) {
      [[NSData dataWithBytes:bytes length:length] writeToFile:@(path) atomically:NO];
      CFRelease(surface);
      break;
    }
    CFRelease(surface);
  }
  printf("render: %zu sampled bytes are not zero\n", lit);
  return lit > 0 ? 0 : 1;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc < 2) return usage();
    NSString *command = @(argv[1]);
    if ([command isEqualToString:@"state"]) return state();
    if ([command isEqualToString:@"where"]) return where();
    if ([command isEqualToString:@"windows"]) return windows();
    if ([command isEqualToString:@"hiddevice"]) return hiddevice();
    if (argc == 3 && [command isEqualToString:@"ax"]) return ax((pid_t)atoi(argv[2]));
    if (argc == 3 && [command isEqualToString:@"render"]) return render(argv[2]);
    if (argc == 3 && [command isEqualToString:@"capture"]) return capture(argv[2]);
    if (argc == 3 && [command isEqualToString:@"wincapture"]) return wincapture(argv[2]);
    if (argc == 3 && [command isEqualToString:@"sck"]) return sck(argv[2]);
    if (argc == 4) {
      CGPoint to = CGPointMake(atof(argv[2]), atof(argv[3]));
      if ([command isEqualToString:@"move"]) return move(to);
      if ([command isEqualToString:@"warp"]) return warp(to);
      if ([command isEqualToString:@"hidpost"]) return hidpost(to);
    }
    return usage();
  }
}
