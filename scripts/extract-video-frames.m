#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 3) {
            fprintf(stderr, "usage: extract-video-frames <input.mp4> <output-directory> [frame-count]\n");
            return 2;
        }

        NSString *inputPath = [NSString stringWithUTF8String:argv[1]];
        NSString *outputPath = [NSString stringWithUTF8String:argv[2]];
        NSInteger frameCount = argc >= 4 ? MAX(4, atoi(argv[3])) : 16;
        NSError *directoryError = nil;
        [[NSFileManager defaultManager] createDirectoryAtPath:outputPath
                                 withIntermediateDirectories:YES
                                                  attributes:nil
                                                       error:&directoryError];
        if (directoryError) {
            fprintf(stderr, "%s\n", directoryError.localizedDescription.UTF8String);
            return 1;
        }

        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:inputPath] options:nil];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        double durationSeconds = CMTimeGetSeconds(asset.duration);
#pragma clang diagnostic pop
        if (!isfinite(durationSeconds) || durationSeconds <= 0) {
            fprintf(stderr, "동영상 길이를 읽을 수 없습니다.\n");
            return 1;
        }

        AVAssetImageGenerator *generator = [[AVAssetImageGenerator alloc] initWithAsset:asset];
        generator.appliesPreferredTrackTransform = YES;
        generator.requestedTimeToleranceBefore = kCMTimeZero;
        generator.requestedTimeToleranceAfter = kCMTimeZero;

        NSMutableArray<NSImage *> *images = [NSMutableArray array];
        NSMutableArray<NSNumber *> *times = [NSMutableArray array];
        for (NSInteger index = 0; index < frameCount; index++) {
            double seconds = durationSeconds * ((double)index + 0.5) / (double)frameCount;
            CMTime requestedTime = CMTimeMakeWithSeconds(seconds, 600);
            CMTime actualTime = kCMTimeZero;
            NSError *frameError = nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            CGImageRef cgImage = [generator copyCGImageAtTime:requestedTime
                                                  actualTime:&actualTime
                                                       error:&frameError];
#pragma clang diagnostic pop
            if (!cgImage) {
                fprintf(stderr, "frame %ld: %s\n", (long)index, frameError.localizedDescription.UTF8String);
                continue;
            }

            double actualSeconds = CMTimeGetSeconds(actualTime);
            NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cgImage];
            NSData *jpeg = [bitmap representationUsingType:NSBitmapImageFileTypeJPEG
                                                 properties:@{NSImageCompressionFactor: @0.9}];
            NSString *fileName = [NSString stringWithFormat:@"frame-%02ld-%06.2fs.jpg",
                                                            (long)index + 1,
                                                            actualSeconds];
            [jpeg writeToFile:[outputPath stringByAppendingPathComponent:fileName] atomically:YES];
            [images addObject:[[NSImage alloc] initWithCGImage:cgImage size:NSZeroSize]];
            [times addObject:@(actualSeconds)];
            CGImageRelease(cgImage);
        }

        if (images.count == 0) {
            fprintf(stderr, "프레임을 추출하지 못했습니다.\n");
            return 1;
        }

        NSSize imageSize = images.firstObject.size;
        CGFloat maxThumb = 320;
        CGFloat scale = MIN(maxThumb / imageSize.width, maxThumb / imageSize.height);
        NSSize thumbSize = NSMakeSize(MAX(1, floor(imageSize.width * scale)),
                                      MAX(1, floor(imageSize.height * scale)));
        CGFloat labelHeight = 28;
        NSInteger columns = MIN(5, images.count);
        NSInteger rows = (NSInteger)ceil((double)images.count / (double)columns);
        NSSize sheetSize = NSMakeSize(thumbSize.width * columns,
                                      (thumbSize.height + labelHeight) * rows);
        NSImage *sheet = [[NSImage alloc] initWithSize:sheetSize];
        [sheet lockFocus];
        [NSColor.blackColor setFill];
        NSRectFill(NSMakeRect(0, 0, sheetSize.width, sheetSize.height));

        NSDictionary *labelAttributes = @{
            NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:15 weight:NSFontWeightMedium],
            NSForegroundColorAttributeName: NSColor.whiteColor
        };

        for (NSInteger index = 0; index < images.count; index++) {
            NSInteger column = index % columns;
            NSInteger row = index / columns;
            CGFloat x = column * thumbSize.width;
            CGFloat y = sheetSize.height - (row + 1) * (thumbSize.height + labelHeight);
            [images[index] drawInRect:NSMakeRect(x, y + labelHeight, thumbSize.width, thumbSize.height)
                             fromRect:NSZeroRect
                            operation:NSCompositingOperationCopy
                             fraction:1];
            NSString *label = [NSString stringWithFormat:@"%02ld  %.2fs",
                                                         (long)index + 1,
                                                         times[index].doubleValue];
            [label drawAtPoint:NSMakePoint(x + 8, y + 5) withAttributes:labelAttributes];
        }
        [sheet unlockFocus];

        NSBitmapImageRep *sheetBitmap = [[NSBitmapImageRep alloc] initWithData:sheet.TIFFRepresentation];
        NSData *sheetJpeg = [sheetBitmap representationUsingType:NSBitmapImageFileTypeJPEG
                                                       properties:@{NSImageCompressionFactor: @0.88}];
        NSString *sheetPath = [outputPath stringByAppendingPathComponent:@"contact-sheet.jpg"];
        [sheetJpeg writeToFile:sheetPath atomically:YES];

        printf("duration=%.3f\n", durationSeconds);
        printf("frames=%lu\n", (unsigned long)images.count);
        printf("contactSheet=%s\n", sheetPath.UTF8String);
    }
    return 0;
}
