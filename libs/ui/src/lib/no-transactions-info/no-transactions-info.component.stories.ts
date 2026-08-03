import { GfLogoComponent } from '@ghostfolio/ui/logo';

import '@angular/localize/init';
import { moduleMetadata } from '@storybook/angular';
import type { Meta, StoryObj } from '@storybook/angular';

import { GfNoTransactionsInfoComponent } from './no-transactions-info.component';

export default {
  title: 'No Transactions Info',
  component: GfNoTransactionsInfoComponent,
  decorators: [
    moduleMetadata({
      imports: [GfLogoComponent]
    })
  ]
} as Meta<GfNoTransactionsInfoComponent>;

type Story = StoryObj<GfNoTransactionsInfoComponent>;

export const Default: Story = {
  args: {}
};
