import path from 'path';
import { Route } from './types';

function concatArrayOfText(texts: string[]): string {
  const last = texts.pop();
  return `${texts.join(', ')}, and ${last}`;
}

// Takes a filename or foldername, strips the extension
// gets the part between the "[]" brackets.
// It will return `null` if there are no brackets
// and therefore no segment.
function getSegmentName(segment: string): string | null {
  const { name } = path.parse(segment);

  if (name.startsWith('[') && name.endsWith(']')) {
    return name.slice(1, -1);
  }

  return null;
}

function createRouteFromPath(filePath: string): Route {
  const parts = filePath.split('/');

  let append: string = '';
  let counter: number = 1;
  const query: string[] = [];

  const srcParts = parts.map(
    (segment, index): string => {
      const name = getSegmentName(segment);
      const isLast = index === parts.length - 1;

      if (name !== null) {
        query.push(`${name}=$${counter++}`);

        if (isLast) {
          // We append this to the last one
          // to make sure GET params still work
          // and are just appended to our GET params
          append += `$${counter++}`;
          return `([^\\/|\\?]+)\\/?(?:\\?(.*))?`;
        }

        return `([^\\/]+)`;
      } else if (isLast) {
        // If it is the last part we want to remove the extension
        // and capture everything after that as regex group and append it
        const { name: fileName } = path.parse(segment);
        append += `$${counter++}`;
        return `${fileName}(.*)`;
      }

      return segment;
    }
  );

  const src = `^/${srcParts.join('/')}$`;
  const dest = `/${filePath}${query.length ? '?' : ''}${query.join('&')}${
    query.length ? '&' : ''
  }${append}`;

  return { src, dest };
}

// Check if the path partially matches and has the same
// name for the path segment at the same position
function partiallyMatches(pathA: string, pathB: string): boolean {
  const partsA = pathA.split('/');
  const partsB = pathB.split('/');

  const long = partsA.length > partsB.length ? partsA : partsB;
  const short = long === partsA ? partsB : partsA;

  let index = 0;

  for (const segmentShort of short) {
    const segmentLong = long[index];

    const nameLong = getSegmentName(segmentLong);
    const nameShort = getSegmentName(segmentShort);

    // If there are no segments or the paths differ we
    // return as they are not matching
    if (segmentShort !== segmentLong && (!nameLong || !nameShort)) {
      return false;
    }

    if (nameLong !== nameShort) {
      return true;
    }

    index += 1;
  }

  return false;
}

// Counts how often a path occurres when all placeholders
// got resolved, so we can check if they have conflicts
function pathOccurrences(filePath: string, files: string[]): string[] {
  const getAbsolutePath = (unresolvedPath: string): string => {
    const { dir, name } = path.parse(unresolvedPath);
    const parts = path.join(dir, name).split('/');
    return parts.map(part => part.replace(/\[.*\]/, '1')).join('/');
  };

  const currentAbsolutePath = getAbsolutePath(filePath);

  return files.reduce((prev: string[], file: string): string[] => {
    const absolutePath = getAbsolutePath(file);

    if (absolutePath === currentAbsolutePath) {
      prev.push(file);
    } else if (partiallyMatches(filePath, file)) {
      prev.push(file);
    }

    return prev;
  }, []);
}

// Checks if a placeholder with the same name is used
// multiple times inside the same path
function getConflictingSegment(filePath: string): string | null {
  const segments = new Set<string>();

  for (const segment of filePath.split('/')) {
    const name = getSegmentName(segment);

    if (name !== null && segments.has(name)) {
      return name;
    }

    if (name) {
      segments.add(name);
    }
  }

  return null;
}

function sortFilesBySegmentCount(fileA: string, fileB: string): number {
  const lengthA = fileA.split('/').length;
  const lengthB = fileB.split('/').length;

  if (lengthA > lengthB) {
    return -1;
  }

  if (lengthA < lengthB) {
    return 1;
  }

  // Paths that have the same segment length but
  // less placeholders are preferred
  const countSegments = (prev: number, segment: string) =>
    getSegmentName(segment) ? prev + 1 : 0;
  const segmentLengthA = fileA.split('/').reduce(countSegments, 0);
  const segmentLengthB = fileB.split('/').reduce(countSegments, 0);

  if (segmentLengthA > segmentLengthB) {
    return 1;
  }

  if (segmentLengthA < segmentLengthB) {
    return -1;
  }

  return 0;
}

export async function detectApiRoutes(
  files: string[]
): Promise<{
  defaultRoutes: Route[] | null;
  error: { [key: string]: string } | null;
}> {
  if (!files || files.length === 0) {
    return { defaultRoutes: null, error: null };
  }

  // The deepest routes need to be
  // the first ones to get handled
  const sortedFiles = files.sort(sortFilesBySegmentCount);

  const defaultRoutes: Route[] = [];

  for (const file of sortedFiles) {
    // We only consider every file in the api directory
    // as we will strip extensions as well as resolving "[segments]"
    if (!file.startsWith('api/')) {
      continue;
    }

    const conflictingSegment = getConflictingSegment(file);

    console.log({ file, conflictingSegment });

    if (conflictingSegment) {
      return {
        defaultRoutes: null,
        error: {
          code: 'conflicting_path_segment',
          message:
            `The segment "${conflictingSegment}" occurres more than ` +
            `one time in your path "${file}". Please make sure that ` +
            `every segment in a path is unique`,
        },
      };
    }

    const occurrences = pathOccurrences(file, sortedFiles).filter(
      name => name !== file
    );

    if (occurrences.length > 0) {
      const messagePaths = concatArrayOfText(
        occurrences.map(name => `"${name}"`)
      );

      return {
        defaultRoutes: null,
        error: {
          code: 'conflicting_file_path',
          message:
            `Two or more files have conflicting paths or names. ` +
            `Please make sure path segments and filenames, without their extension, are unique. ` +
            `The path "${file}" has conflicts with ${messagePaths}`,
        },
      };
    }

    defaultRoutes.push(createRouteFromPath(file));
  }

  return { defaultRoutes, error: null };
}
