import { Tag } from '@prisma/client';

export interface CreateOrUpdateTagDialogParams {
  /**
   * The names already taken in the scope this tag will be written to.
   *
   * Supplied so the dialog can refuse a repeat before it closes. It has to be the
   * names of the *same scope* rather than every name on the screen: a tag is unique
   * per owner, so a global tag and a user's tag may share a name legitimately, and
   * the caller is the only side that knows which scope the write lands in. The name
   * being edited is expected to have been left out already.
   */
  existingNames: string[];

  tag: Pick<Tag, 'id' | 'name'>;
}
