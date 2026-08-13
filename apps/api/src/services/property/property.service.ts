import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import {
  PROPERTY_CURRENCIES,
  PROPERTY_IS_USER_SIGNUP_ENABLED
} from '@ghostfolio/common/config';

import { Injectable } from '@nestjs/common';
import type { Property as PropertyModel } from '@prisma/client';

import { PropertyValue } from './interfaces/interfaces';

@Injectable()
export class PropertyService {
  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Removes a property, whether or not it is there.
   *
   * `deleteMany` rather than `delete`, because the caller's intent is that the key
   * ends up absent and that intent is satisfied either way. `delete` raises Prisma's
   * P2025 when no row matches, which surfaced as a 500: clearing a setting twice -
   * two administrators at once, a retried request, or simply clearing something
   * already cleared - reported a server fault for an operation that had in fact
   * succeeded.
   *
   * @returns the row that was removed, or `null` when there was nothing to remove.
   * The value is returned rather than the delete count because the administration
   * endpoint answers with the affected property, and `null` is the honest answer for
   * a key that did not exist.
   */
  public async delete({ key }: { key: string }): Promise<PropertyModel | null> {
    const property = await this.prismaService.property.findUnique({
      where: { key }
    });

    // Unconditional, and deliberately not guarded by the read above: between the
    // two statements another caller may have removed the row, which is exactly the
    // concurrent case this method has to tolerate. `deleteMany` matching nothing is
    // a no-op rather than an error.
    await this.prismaService.property.deleteMany({
      where: { key }
    });

    return property;
  }

  public async get() {
    const response: {
      [key: string]: PropertyValue;
    } = {
      [PROPERTY_CURRENCIES]: []
    };

    const properties = await this.prismaService.property.findMany();

    for (const property of properties) {
      let value = property.value;

      try {
        value = JSON.parse(property.value);
      } catch {}

      response[property.key] = value;
    }

    return response;
  }

  public async getByKey<TValue extends PropertyValue>(aKey: string) {
    const properties = await this.get();
    return properties[aKey] as TValue;
  }

  public async isUserSignupEnabled() {
    return (
      (await this.getByKey<boolean>(PROPERTY_IS_USER_SIGNUP_ENABLED)) ?? true
    );
  }

  public async put({ key, value }: { key: string; value: string }) {
    return this.prismaService.property.upsert({
      create: { key, value },
      update: { value },
      where: { key }
    });
  }
}
