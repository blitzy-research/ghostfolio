import { CommonModule } from '@angular/common';
import '@angular/localize/init';
import { moduleMetadata } from '@storybook/angular';
import type { Meta, StoryObj } from '@storybook/angular';

import { GfPremiumIndicatorComponent } from './premium-indicator.component';

export default {
  title: 'Premium Indicator',
  component: GfPremiumIndicatorComponent,
  decorators: [
    moduleMetadata({
      imports: [CommonModule]
    })
  ]
} as Meta<GfPremiumIndicatorComponent>;

type Story = StoryObj<GfPremiumIndicatorComponent>;

export const Default: Story = {
  args: {}
};

export const WithoutLink = {
  args: {
    enableLink: false
  }
};
